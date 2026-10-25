// The hourly bake preflight. A read failure is an error, never evidence that images are current or stale.
import { DescribeImagesCommand } from '@aws-sdk/client-ec2';
import { createAws } from '../../lib/aws.mjs';
import { resolveRepos, repoSlug } from '../../pool/bake/manifest.mjs';
import { newestReadyImage } from '../launcher/logic.mjs';

const REGION = 'us-central1';
const JOBS = ['ci-kit-bake', 'ci-kit-bake-check'];
const tagsOf = image => Object.fromEntries((image.Tags ?? []).map(({ Key, Value }) => [Key, Value]));

export async function listBakeExecutions({ project, job, token, fetchImpl = fetch }) {
  const executions = [];
  let pageToken;
  do {
    const url = new URL(`https://run.googleapis.com/v2/projects/${project}/locations/${REGION}/jobs/${job}/executions`);
    url.searchParams.set('pageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${await token()}` }, signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`bake: cannot list ${job} executions (HTTP ${response.status})`);
    const page = await response.json();
    executions.push(...(page.executions ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return executions;
}

// Pending executions count too; runningCount=0 alone does not mean finished. A failed/cancelled execution can
// carry a terminal Completed condition without completionTime, so either terminal signal releases the guard.
const finished = execution => execution.completionTime || execution.conditions?.some(condition =>
  condition.type === 'Completed' && ['CONDITION_SUCCEEDED', 'CONDITION_FAILED'].includes(condition.state));

async function newestReadyAmi(ec2) {
  const images = [];
  let NextToken;
  do {
    const page = await ec2.send(new DescribeImagesCommand({
      Owners: ['self'], Filters: [
        { Name: 'tag:ci-kit-pool', Values: ['ec2'] }, { Name: 'tag:ci-kit-ready', Values: ['true'] }, { Name: 'state', Values: ['available'] },
      ], ...(NextToken ? { NextToken } : {}),
    }));
    images.push(...(page.Images ?? []));
    NextToken = page.NextToken;
  } while (NextToken);
  return images.filter(image => image.State === 'available' && tagsOf(image)['ci-kit-pool'] === 'ec2' && tagsOf(image)['ci-kit-ready'] === 'true')
    .sort((a, b) => Date.parse(b.CreationDate) - Date.parse(a.CreationDate))[0];
}

// true continues the same execution as a normal bake; false is a successful no-op. Every configured account is
// checked, even one disabled for job placement: bakeProviders still bakes those accounts.
export async function checkStale({ cfg, gce, gh, accounts, token, execution, job,
  listExecutions = job => listBakeExecutions({ project: cfg.project, job, token }),
  awsFor = account => createAws({ roleArn: account.roles.bake, region: account.region, log }), log = console.log,
}) {
  if (!execution || !JOBS.includes(job)) throw new Error('bake: stale check needs its Cloud Run execution and job identity');
  const self = `${job}/executions/${execution}`;
  const executions = [];
  for (const name of JOBS) executions.push(...await listExecutions(name));
  const running = executions.filter(e => !e.name.endsWith(`/jobs/${self}`) && !finished(e));
  if (running.length) {
    log(`bake: skipped; ${running.map(e => e.name).join(', ')} still running`);
    return false;
  }
  const repos = await resolveRepos({ gh, repos: cfg.repos });
  const gceImage = newestReadyImage(await gce.images('labels.ci-kit=gce-image'), cfg.image_family);
  const images = [{ provider: 'gce', image: gceImage, hashes: gceImage?.labels, key: repo => `ci-kit-setup-${repoSlug(repo)}` }];
  for (const account of accounts) {
    const image = await newestReadyAmi(awsFor(account).ec2);
    images.push({ provider: `ec2/${account.account}`, image, hashes: image && tagsOf(image), key: repo => `ci-kit-setup:${repo}` });
  }
  let stale = false;
  for (const { provider, image, hashes, key } of images) {
    if (!image) {
      log(`bake: stale ${provider}: no ready image`);
      stale = true;
      continue;
    }
    for (const { repo } of cfg.repos) {
      const expected = repos[repo]?.setup_hash ?? 'none';
      const actual = hashes?.[key(repo)] ?? 'none';
      if (actual === expected) continue;
      log(`bake: stale ${repo} on ${provider}: ${actual} -> ${expected}`);
      stale = true;
    }
  }
  if (!stale) log('bake: images current');
  return stale;
}
