#!/usr/bin/env node
// Independent EC2 backstop, one GitHub Actions leg per configured account (disabled accounts included).
// Env: GitHub's OIDC request pair and CI_KIT_APP_ID/CI_KIT_APP_KEY. AWS credentials live only in memory.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { STSClient, AssumeRoleWithWebIdentityCommand } from '@aws-sdk/client-sts';
import {
  EC2Client, DescribeInstancesCommand, DescribeVolumesCommand, DescribeImagesCommand, DescribeSnapshotsCommand,
  TerminateInstancesCommand, DeleteVolumeCommand, DeregisterImageCommand, DeleteSnapshotCommand,
} from '@aws-sdk/client-ec2';
import { createGitHub } from '../lib/github.mjs';
import { withAwsDeadline } from '../lib/aws.mjs';
import { createAppTokens } from '../lib/github-app.mjs';
import { parseEc2Config } from '../gce/launcher/config.mjs';
import { rowsOf } from '../gce/launcher/ledger.mjs';
import { imagesToPrune } from './bake/bake.mjs';

const REGION = 'us-east-2';
const TIMEOUT_MS = 30_000;
const POOL_FILTER = [{ Name: 'tag:ci-kit-pool', Values: ['ec2'] }];
const tagsOf = (resource) => Object.fromEntries((resource.Tags ?? []).map(({ Key, Value }) => [Key, Value]));
const pooled = (resource) => tagsOf(resource)['ci-kit-pool'] === 'ec2';
const expired = (resource, now) => Date.parse(tagsOf(resource)['ci-kit-deadline']) < now;
const snapshotsOf = (image) => (image.BlockDeviceMappings ?? []).map((d) => d.Ebs?.SnapshotId).filter(Boolean);
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function readGuardAccounts(path = new URL('../pool/config/ec2.json', import.meta.url)) {
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  // Eligibility is deliberately not a filter: disabling launches must not disable the safety net.
  return parseEc2Config(text).accounts;
}

// A guard never creates/rotates/closes the allocation ledger. Read closed issues too: a late VM can carry an
// already-final allocation from a retired issue. Any failed page rejects this whole snapshot, not an empty ledger.
export async function readGuardRows(gh, { repo, issue_title: title }) {
  const pattern = new RegExp(`^${escape(title)}( from \\d{4}-\\d{2}-\\d{2})?$`);
  const listed = [...await gh.openIssues(repo), ...await gh.closedIssuesSince(repo, '1970-01-01T00:00:00.000Z')];
  const issues = [...new Map(listed.filter((i) => !i.pull_request && pattern.test(i.title)).map((i) => [i.number, i])).values()];
  return rowsOf((await Promise.all(issues.map((i) => gh.issueComments(repo, i.number)))).flat());
}

// The Google-backed runtime credential provider requests four-hour sessions. The guard is a distinct GitHub
// identity and uses the guard role's ordinary one-hour maximum; neither path resolves stored AWS keys.
export async function createGuardAws(cfg, { env = process.env, fetchImpl = fetch, sts, now = Date.now, log = console.log } = {}) {
  if (cfg.region !== REGION) throw new Error('guard: EC2 is restricted to us-east-2');
  const roleArn = cfg.roles?.guard;
  if (!/^\d{12}$/.test(cfg.account) || !new RegExp(`^arn:aws:iam::${cfg.account}:role/[\\w+=,.@/-]+$`).test(roleArn ?? '')) {
    throw new Error('guard: role ARN must name the configured account');
  }
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) throw new Error('guard: GitHub OIDC request credentials are required');
  const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  url.searchParams.set('audience', 'sts.amazonaws.com');
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`guard: GitHub OIDC HTTP ${res.status}`);
  let identity;
  try { identity = await res.json(); } catch { throw new Error('guard: invalid GitHub OIDC response'); }
  if (typeof identity.value !== 'string' || !identity.value.trim()) throw new Error('guard: GitHub OIDC returned no token');
  const ownedSts = !sts;
  sts ??= withAwsDeadline(new STSClient({ region: REGION, endpoint: `https://sts.${REGION}.amazonaws.com`, maxAttempts: 1,
    credentials: async () => { throw new Error('guard: signed STS operations are not supported'); },
    requestHandler: { requestTimeout: TIMEOUT_MS, connectionTimeout: 5000 } }));
  let c;
  try {
    ({ Credentials: c } = await sts.send(new AssumeRoleWithWebIdentityCommand({
      RoleArn: roleArn, RoleSessionName: 'ci-kit-guard', DurationSeconds: 3600, WebIdentityToken: identity.value,
    })));
  } finally { if (ownedSts) sts.destroy(); }
  const expiration = new Date(c?.Expiration);
  if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !(expiration.getTime() - now() >= 15 * 60_000)) {
    throw new Error('guard: STS returned an incomplete or too-short session');
  }
  const credentials = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration };
  log(`guard: assumed ${roleArn} until ${expiration.toISOString()}`);
  return { ec2: withAwsDeadline(new EC2Client({ region: REGION, credentials, maxAttempts: 2,
    requestHandler: { requestTimeout: TIMEOUT_MS, connectionTimeout: 5000 } })) };
}

async function list(ec2, Command, input, field) {
  const items = [];
  let NextToken;
  do {
    const res = await ec2.send(new Command({ ...input, ...(NextToken ? { NextToken } : {}) }));
    items.push(...(res[field] ?? []));
    NextToken = res.NextToken;
  } while (NextToken);
  return items;
}

// Return the number of failed reads/actions after trying independent cleanup. Null inventories are unknown,
// never empty: a failed ledger cannot prove no row, nor a failed instance list prove an orphan volume.
export async function runEc2Guard({ ec2, gh, ledger, account, now = Date.now, log = console.log, error = console.error }) {
  let failed = 0;
  const prefix = `guard ec2/${account}`;
  async function read(label, fn) {
    try { return await fn(); }
    catch (err) { failed++; error(`${prefix}: ${label} failed: ${err.message}`); return null; }
  }
  async function act(label, fn) {
    log(`${prefix}: ${label}`);
    try { await fn(); return true; }
    catch (err) { failed++; error(`${prefix}: ${label} failed: ${err.message}`); return false; }
  }
  const [instances, volumes, images, snapshots, rows] = await Promise.all([
    read('list instances', async () => (await list(ec2, DescribeInstancesCommand, { Filters: POOL_FILTER }, 'Reservations')).flatMap((r) => r.Instances ?? []).filter(pooled)),
    read('list volumes', async () => (await list(ec2, DescribeVolumesCommand, { Filters: POOL_FILTER }, 'Volumes')).filter(pooled)),
    // All owned image references protect snapshots, including non-pool and disabled/deprecated images.
    // The mutation policy below still selects only pool-tagged AMIs.
    read('list images', () => list(ec2, DescribeImagesCommand, { Owners: ['self'], IncludeDeprecated: true, IncludeDisabled: true }, 'Images')),
    read('list snapshots', async () => (await list(ec2, DescribeSnapshotsCommand, { OwnerIds: ['self'], Filters: POOL_FILTER }, 'Snapshots')).filter(pooled)),
    read('read ledger', () => readGuardRows(gh, ledger)),
  ]);
  const at = now();
  const byInstance = new Map((instances ?? []).map((i) => [i.InstanceId, i]));
  const byAlloc = new Map((rows ?? []).filter((r) => r.provider === 'ec2' && r.account === account).map((r) => [r.alloc, r]));
  const terminations = new Map();
  async function terminate(instance, reason) {
    const id = instance.InstanceId;
    if (['terminated', 'shutting-down'].includes(instance.State?.Name)) return true;
    if (!terminations.has(id)) terminations.set(id, await act(`terminate ${id}: ${reason}`, () => ec2.send(new TerminateInstancesCommand({ InstanceIds: [id] }))));
    return terminations.get(id);
  }
  for (const i of instances ?? []) {
    if (['terminated', 'shutting-down'].includes(i.State?.Name)) continue;
    const tags = tagsOf(i), row = byAlloc.get(tags['ci-kit-alloc']);
    let reason;
    if (expired(i, at)) reason = 'deadline';
    else if (tags['ci-kit-purpose'] === 'job') {
      if (i.State?.Name === 'stopped') reason = 'stopped job';
      else if (rows !== null && row?.state === 'final') reason = 'final ledger row';
      else if (rows !== null && !row && at - new Date(i.LaunchTime).getTime() >= 15 * 60_000) reason = 'no ledger row after 15 min';
    }
    if (reason) await terminate(i, reason);
  }
  for (const v of volumes ?? []) {
    const overdue = expired(v, at);
    const orphan = instances !== null && tagsOf(v)['ci-kit-purpose'] === 'job' && !v.Attachments?.length;
    if (!overdue && !orphan) continue;
    let current = v;
    if (v.Attachments?.length) {
      // A tag-filtered inventory cannot authorize termination of an unseen (possibly foreign) attachment.
      const owners = v.Attachments.map((a) => byInstance.get(a.InstanceId));
      if (owners.some((i) => !i)) { log(`${prefix}: defer ${v.VolumeId}: attachment not in known pool inventory`); continue; }
      if (owners.some((i) => ['builder', 'smoke'].includes(tagsOf(i)['ci-kit-purpose']) && !expired(i, at))) {
        log(`${prefix}: defer ${v.VolumeId}: builder/smoke attachment before its deadline`);
        continue;
      }
      let terminated = true;
      for (const i of owners) if (!await terminate(i, `volume ${v.VolumeId} deadline`)) terminated = false;
      if (!terminated) continue;
      const fresh = await read(`refresh volume ${v.VolumeId}`, async () => {
        try { return await list(ec2, DescribeVolumesCommand, { VolumeIds: [v.VolumeId] }, 'Volumes'); }
        catch (err) { if (err.name === 'InvalidVolume.NotFound') return []; throw err; }
      });
      current = fresh?.find((x) => x.VolumeId === v.VolumeId);
      if (!current || !pooled(current)) continue;
    }
    if (current.Attachments?.length || current.State !== 'available') {
      // Termination is asynchronous; DeleteOnTermination normally removes this volume. A survivor is retried
      // next cycle, without force-detaching disks or blocking a guard leg waiting for all instances to exit.
      log(`${prefix}: defer ${v.VolumeId}: not yet available`);
      continue;
    }
    if (!expired(current, at) && !(instances !== null && tagsOf(current)['ci-kit-purpose'] === 'job')) continue;
    await act(`delete volume ${v.VolumeId}: ${overdue ? 'deadline' : 'unattached job'}`, () =>
      ec2.send(new DeleteVolumeCommand({ VolumeId: v.VolumeId })).catch(err => {
        if (err.name !== 'InvalidVolume.NotFound') throw err; // another cleanup path won the deletion race
      }));
  }
  if (images !== null && snapshots !== null) {
    const doomed = imagesToPrune(images, at);
    const removed = new Set();
    for (const i of doomed) {
      if (await act(`deregister image ${i.ImageId}: image retention`, () => ec2.send(new DeregisterImageCommand({ ImageId: i.ImageId })))) removed.add(i.ImageId);
    }
    // A retained/in-flight image (or failed deregistration) protects shared snapshots, even when the image
    // is not pool-tagged. Both inventories must be complete before absence can establish an orphan.
    const protectedIds = new Set(images.filter((i) => !removed.has(i.ImageId)).flatMap(snapshotsOf));
    const removedIds = new Set(doomed.filter((i) => removed.has(i.ImageId)).flatMap(snapshotsOf));
    for (const [id, snapshot] of new Map(snapshots.map(s => [s.SnapshotId, s]))) {
      if (protectedIds.has(id)) continue;
      // A failed deletion must remain discoverable after deregistration has erased the AMI mapping.
      // A full day (the unready-image retention window) protects newly-created bake snapshots; incomplete
      // snapshots and unknown ages never establish an orphan. VM deadlines do not govern image artifacts.
      const orphan = snapshot.State === 'completed' && at - new Date(snapshot.StartTime ?? NaN).getTime() > 86400_000;
      const reason = removedIds.has(id) ? 'image retention' : orphan ? 'orphan snapshot older than one day' : null;
      if (reason) await act(`delete snapshot ${id}: ${reason}`, () => ec2.send(new DeleteSnapshotCommand({ SnapshotId: id })));
    }
  }
  return failed;
}

async function main(argv) {
  const accounts = await readGuardAccounts();
  if (argv.length === 1 && argv[0] === '--matrix') { console.log(JSON.stringify(accounts.map((a) => a.account))); return; }
  if (argv.length !== 2 || argv[0] !== '--account') throw new Error('usage: node ec2/guard.mjs --matrix | --account <id>');
  const cfg = accounts.find((a) => a.account === argv[1]);
  if (!cfg) throw new Error(`guard: account ${argv[1]} is not configured`);
  const { ledger } = JSON.parse(await readFile(new URL('../pool/config/gce.json', import.meta.url), 'utf8'));
  const gh = createGitHub(createAppTokens({ appId: process.env.CI_KIT_APP_ID?.trim(), pem: process.env.CI_KIT_APP_KEY,
    owner: ledger.repo.split('/')[0], scope: { repositories: [ledger.repo.split('/')[1]], permissions: { issues: 'read' } } }));
  const aws = await createGuardAws(cfg);
  try { if (await runEc2Guard({ ec2: aws.ec2, gh, ledger, account: cfg.account })) process.exitCode = 1; }
  finally { aws.ec2.destroy(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => { console.error(`guard: ${err.message}`); process.exitCode = 1; });
}
