#!/usr/bin/env node
// The gate ledger's preflight (ci-kit docs/doperpowers/specs/2026-11-19-gate-ledger-design.md, "Reading GitHub cheaply
// and completely"): proves, with the token the daily collection has, every read the ledger rests on.
//   node history/preflight.mjs --plan '<json>'
// The plan names, per repository: its gate workflow file, its default branch, candidate runs that were rerun (`reruns`),
// runs whose ref may be gone (`nonce`), and runs with a failed job (`failed`). For each repository it prints:
//   - the run listing of one UTC day by creation (total_count, and whether a run carries head_commit and pull_requests);
//   - both attempts' jobs of the first candidate rerun that carried a job over, and how the later listing marks it;
//   - the annotations of one unsuccessful job, and its log, by status, count and matched platform kind only;
//   - the activity listing of the default branch;
//   - the mirror clone (tree-only), and a fetch by id of a nonce commit whose ref is gone, with its parent.
// It prints ids, names of jobs and runners, counts and statuses only: never a commit message, a path, an annotation's
// text or a log line.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGitHub } from '../lib/github.mjs';
import { tokenFor } from './collect.mjs';
import { platformKind } from './jobs.mjs';

const say = (...parts) => console.log(parts.join(' '));

// git with the token as an extra header (never on the command line), lazy fetches off.
function git(dir, args, token) {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` };
  const r = spawnSync('git', dir ? ['-C', dir, ...args] : args, { env, encoding: 'utf8', maxBuffer: 1 << 28 });
  const err = (r.stderr ?? '').trim().split('\n').at(-1)?.slice(0, 200) ?? '';
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err };
}

async function attempt(label, fn) {
  try {
    return await fn();
  } catch (err) {
    say(`  ${label}: refused or failed: ${err.status ?? ''} ${(err.message ?? String(err)).slice(0, 200)}`);
    return null;
  }
}

async function preflightRepo(entry) {
  const { repo, workflow, branch, reruns = [], nonce = [], failed = [], day = '2026-11-18' } = entry;
  const token = tokenFor(repo);
  const gh = createGitHub(token);
  say(`== ${repo}`);

  // 1. The listing.
  await attempt('listing', async () => {
    const body = await gh.request('GET', `/repos/${repo}/actions/workflows/${workflow}/runs?created=${day}&per_page=100`);
    const first = body.workflow_runs[0];
    say(`  listing ${workflow} created=${day}: total_count ${body.total_count}, page ${body.workflow_runs.length}, head_commit.tree_id ${Boolean(first?.head_commit?.tree_id)}, pull_requests field ${Array.isArray(first?.pull_requests)}, events ${[...new Set(body.workflow_runs.map((r) => r.event))].join('/')}`);
  });

  // 2. A rerun's two attempts.
  let unsuccessful = null;
  for (const id of reruns) {
    const found = await attempt(`rerun ${id}`, async () => {
      const run = await gh.getRun(repo, id);
      const n = run.run_attempt;
      const later = await gh.attemptJobs(repo, id, n);
      const earlier = await gh.attemptJobs(repo, id, n - 1);
      const earlierIds = new Set(earlier.map((j) => j.id));
      unsuccessful ??= earlier.find((j) => j.conclusion && j.conclusion !== 'success' && j.conclusion !== 'skipped') ?? null;
      const byField = later.filter((j) => j.run_attempt !== n);
      const byId = later.filter((j) => earlierIds.has(j.id));
      const byTime = later.filter((j) => j.created_at && j.completed_at && j.completed_at < j.created_at);
      say(`  rerun ${id}: attempts ${n}; attempt ${n - 1} jobs ${earlier.length}, attempt ${n} jobs ${later.length}; in attempt ${n}'s listing: run_attempt != ${n}: ${byField.length}, id of an attempt-${n - 1} job: ${byId.length}, completed before created: ${byTime.length}`);
      for (const [k, list] of [[n - 1, earlier], [n, later]]) {
        for (const j of list) {
          say(`    a${k} job ${j.id} "${j.name}" run_attempt ${j.run_attempt} ${j.status}/${j.conclusion} created ${j.created_at} started ${j.started_at} completed ${j.completed_at} runner "${j.runner_name ?? ''}" group "${j.runner_group_name ?? ''}" labels [${(j.labels ?? []).join(',')}] steps ${(j.steps ?? []).length}`);
        }
      }
      return byField.length + byId.length + byTime.length > 0;
    });
    if (found) break;
  }

  // 3. One unsuccessful job's annotations and log.
  for (const id of failed) {
    if (unsuccessful) break;
    await attempt(`failed run ${id}`, async () => {
      const run = await gh.getRun(repo, id);
      unsuccessful = (await gh.attemptJobs(repo, id, run.run_attempt)).find((j) => j.conclusion && j.conclusion !== 'success' && j.conclusion !== 'skipped') ?? null;
    });
  }
  if (unsuccessful) {
    const j = unsuccessful;
    say(`  unsuccessful job ${j.id} "${j.name}" ${j.conclusion}, steps ${(j.steps ?? []).map((s) => s.conclusion ?? s.status).join(',')}`);
    await attempt('annotations', async () => {
      const list = await gh.annotations(repo, j.id);
      const kinds = list.map((a) => platformKind(a.message)).filter(Boolean);
      say(`  annotations: ${list.length}, at .github ${list.filter((a) => a.path === '.github').length}, levels ${[...new Set(list.map((a) => a.annotation_level))].join('/')}, platform kinds [${kinds.join(',')}]`);
    });
    await attempt('log', async () => {
      const text = await gh.jobLog(repo, j.id);
      const kinds = text.split('\n').map(platformKind).filter(Boolean);
      say(`  log: ${text.length} bytes, platform kinds [${[...new Set(kinds)].join(',')}]`);
    });
  } else say('  no unsuccessful job among the candidates');

  // 4. The activity listing.
  await attempt('activity', async () => {
    const list = await gh.request('GET', `/repos/${repo}/activity?ref=${encodeURIComponent(`refs/heads/${branch}`)}&activity_type=push&per_page=100`);
    const keys = list[0] ? Object.keys(list[0]).sort().join(',') : '';
    say(`  activity refs/heads/${branch}: ${list.length} items, newest ${list[0]?.timestamp ?? '-'}, oldest on page ${list.at(-1)?.timestamp ?? '-'}, keys ${keys}, all with before and after ${list.every((a) => /^[0-9a-f]{40}$/.test(a.before) && /^[0-9a-f]{40}$/.test(a.after))}`);
  });

  // 5. The mirror, and a nonce commit fetched by id.
  const root = mkdtempSync(join(tmpdir(), 'ci-kit-preflight-'));
  try {
    const dir = join(root, 'mirror.git');
    const bearer = typeof token === 'function' ? await token(repo) : token;
    const t0 = Date.now();
    const clone = git(null, ['clone', '--quiet', '--bare', '--filter=blob:none', `https://github.com/${repo}.git`, dir], bearer);
    if (!clone.ok) {
      say(`  mirror clone: failed: ${clone.err}`);
      return;
    }
    const size = spawnSync('du', ['-sm', dir], { encoding: 'utf8' }).stdout.split('\t')[0];
    const heads = git(dir, ['for-each-ref', '--format=%(refname)', 'refs/heads'], bearer).out.split('\n').filter(Boolean);
    say(`  mirror clone: ${((Date.now() - t0) / 1000).toFixed(0)} s, ${size} MB, ${heads.length} heads`);
    for (const id of nonce) {
      const ok = await attempt(`nonce run ${id}`, async () => {
        const run = await gh.getRun(repo, id);
        const refGone = !heads.includes(`refs/heads/${run.head_branch}`);
        const before = git(dir, ['cat-file', '-e', `${run.head_sha}^{commit}`], bearer).ok;
        const fetch = git(dir, ['fetch', '--quiet', '--filter=blob:none', 'origin', run.head_sha], bearer);
        const after = git(dir, ['cat-file', '-e', `${run.head_sha}^{commit}`], bearer).ok;
        const parents = after ? git(dir, ['rev-list', '--parents', '-n', '1', run.head_sha], bearer).out.split(' ').slice(1) : [];
        const parentOk = parents.length === 1 && git(dir, ['cat-file', '-e', `${parents[0]}^{tree}`], bearer).ok;
        const diff = parentOk ? git(dir, ['diff-tree', '-r', '--no-renames', '--name-only', parents[0], run.head_sha], bearer) : null;
        say(`  nonce run ${id} (${run.event}): ref gone ${refGone}, present before fetch ${before}, fetch ${fetch.ok ? 'ok' : `failed: ${fetch.err}`}, present after ${after}, parents ${parents.length}, parent's tree present ${parentOk}, paths nonce vs parent ${diff ? (diff.ok ? diff.out.split('\n').filter(Boolean).length : `failed: ${diff.err}`) : '-'}`);
        return refGone && after;
      });
      if (ok) break;
    }
    // A pull request's head by its ref, for M3's landings.
    await attempt('pull head', async () => {
      const body = await gh.request('GET', `/repos/${repo}/actions/workflows/${workflow}/runs?created=${day}&event=pull_request&per_page=5`);
      const pr = body.workflow_runs.find((r) => r.pull_requests?.length)?.pull_requests[0]?.number;
      if (!pr) return say('  pull head: no pull_request run with a number that day');
      const f = git(dir, ['fetch', '--quiet', '--filter=blob:none', 'origin', `refs/pull/${pr}/head`], bearer);
      say(`  pull head refs/pull/${pr}/head: fetch ${f.ok ? 'ok' : `failed: ${f.err}`}`);
    });
    const anc = heads.length ? git(dir, ['merge-base', '--is-ancestor', `refs/heads/${branch}~1`, `refs/heads/${branch}`], bearer) : null;
    say(`  ancestry in the mirror: ${anc?.ok ? 'ok' : `failed: ${anc?.err}`}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    const s = gh.stats();
    say(`  calls ${s.requests}, budget ${s.remaining}/${s.limit}`);
  }
}

async function main(argv) {
  const i = argv.indexOf('--plan');
  if (i < 0) throw new Error("history: usage: preflight.mjs --plan '<json>'");
  for (const entry of JSON.parse(argv[i + 1])) await preflightRepo(entry);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`preflight: ${err.name}: ${(err.message ?? '').slice(0, 200)}`);
    process.exit(1);
  });
}
