// Nothing a private repository says reaches a public log (gate ledger spec, acceptance 8): a sentinel planted in
// every place an error can carry foreign text (a response's body, a network failure's message, a body that is no
// JSON, git's stderr) never appears in what the collector, the mirror or the preflight print.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitHub, GitHubError } from '../../lib/github.mjs';
import { collectBatch } from '../../history/collect.mjs';
import { describeError } from '../../history/errors.mjs';
import { openMirror } from '../../history/mirror.mjs';
import { preflightRepo } from '../../history/preflight.mjs';

const SENTINEL = 'PRIVATE-SENTINEL-7f3a';
const repos = JSON.parse(readFileSync(new URL('../../history/repos.json', import.meta.url), 'utf8'));
const MAWS = repos.find((r) => r.alias === 'SSFSKIM/MAWS');
const NOW = Date.parse('2026-11-19T12:00:00Z');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Everything console prints while fn runs.
async function printed(fn) {
  const out = [];
  const saved = { log: console.log, error: console.error };
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return out.join('\n');
}

// A GitHub whose every failure carries the sentinel: one listing day's body, another's network failure, a third's
// rate limit; a run whose job listing answers 502, and whose annotations answer a body that is no JSON; the
// per-test pass's artifact listing a 500.
function fakeFetch() {
  return async (href) => {
    const url = new URL(href);
    const path = url.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '');
    if (path.startsWith('/actions/workflows/')) {
      const day = url.searchParams.get('created').slice(0, 10);
      if (day === '2026-11-01') return json({ message: `Server Error ${SENTINEL}` }, 502);
      if (day === '2026-11-02') throw new TypeError(`fetch failed: ${SENTINEL}`);
      if (day === '2026-11-03') return json({ message: `Not Found ${SENTINEL}` }, 404);
      const runs = day === '2026-11-18'
        ? [1, 2].map((id) => ({ id, name: 'gate', event: 'push', head_branch: 'master', head_sha: String(id).padStart(40, '0'), head_commit: { tree_id: 't', message: `${SENTINEL} message` }, pull_requests: [], status: 'completed', conclusion: 'failure', run_attempt: 1, created_at: `${day}T0${id}:00:00Z` }))
        : [];
      return json({ total_count: runs.length, workflow_runs: runs });
    }
    if (path === '/actions/runs/1/attempts/1/jobs') return json({ message: `Bad Gateway ${SENTINEL}` }, 502);
    if (path === '/actions/runs/2/attempts/1/jobs') {
      return json({ total_count: 1, jobs: [{ id: 22, name: `e2e:${SENTINEL}`.slice(0, 4), status: 'completed', conclusion: 'failure', created_at: '2026-11-18T02:00:00Z', started_at: '2026-11-18T02:00:00Z', completed_at: '2026-11-18T02:05:00Z', runner_name: 'ci-kit-gce-a', labels: [], steps: [] }] });
    }
    if (path === '/check-runs/22/annotations') return new Response(`<html>${SENTINEL}</html>`, { status: 200 });
    if (path === '/actions/artifacts') return json({ message: SENTINEL }, 500);
    return json({ message: `no route ${SENTINEL}` }, 404);
  };
}

test('the collector prints no response body, network message, unparsable text or git stderr', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ci-kit-privacy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const chosen = [
    { ...MAWS, repo: 'o/broken', alias: 'o/broken' }, // its mirror's clone fails, quoting a path with the sentinel
    { ...MAWS, repo: 'o/r', alias: 'o/r' },
  ];
  const deps = {
    tokenFor: () => 't',
    createGitHub: (token, opts) => createGitHub(token, { ...opts, fetchImpl: fakeFetch() }),
    openMirror: ({ dir, repo }) => (repo === 'o/broken'
      ? openMirror({ dir, url: join(root, `no-such-${SENTINEL}.git`) })
      : { ensure() {}, fetch: () => new Set(), parentOf: () => null, treeKey: () => null }),
  };
  let code;
  const out = await printed(async () => {
    code = await collectBatch({ chosen, opts: { store: join(root, 'store'), mirrors: join(root, 'mirrors'), pass: 'p1', attempts: 300, limit: 40, calls: null }, now: NOW, deps });
  });
  assert.equal(code, 1);
  // Each failure was reached and reported, by its request and status.
  assert.match(out, /o\/broken: ledger: history: the mirror clone failed \(exit \d+\)/);
  assert.match(out, /o\/r: listing 2026-11-01: HTTP 502 GET \/repos\/o\/r\/actions\/workflows\/gate\.yml\/runs/);
  assert.match(out, /o\/r: listing 2026-11-02: TypeError/);
  assert.match(out, /o\/r: run 1 attempt 1: HTTP 502/);
  assert.match(out, /o\/r: run 2 attempt 1: SyntaxError/);
  assert.match(out, /o\/r: per-test: HTTP 500/);
  assert.ok(!out.includes(SENTINEL), out.split('\n').filter((l) => l.includes(SENTINEL)).join('\n'));
});

test('an error that escapes is named by its kind, never its message', () => {
  assert.equal(describeError(new Error(`something ${SENTINEL}`)), 'Error');
  assert.equal(describeError(new GitHubError(403, `HTTP 403 GET /x: API rate limit exceeded ${SENTINEL}`)), 'HTTP 403 (rate limited)');
  assert.equal(describeError(Object.assign(new Error(SENTINEL), { name: `X ${SENTINEL}`, code: 'ENOSPC' })), 'Error ENOSPC');
});

test('the preflight prints no response body or git stderr', async () => {
  const refuse = async () => {
    throw new GitHubError(404, `HTTP 404 GET /repos/o/r/x: ${SENTINEL}`, undefined, { method: 'GET', path: '/repos/o/r/x' });
  };
  const gh = new Proxy({}, { get: (_, name) => (name === 'stats' ? () => ({ requests: 0, remaining: null, limit: null }) : refuse) });
  const git = () => ({ ok: false, out: '', err: 'exit 128' });
  const out = await printed(() => preflightRepo({ repo: 'o/r', workflow: 'gate.yml', branch: 'master', reruns: [1], failed: [2], nonce: [3] }, { gh, git }));
  assert.match(out, /listing: refused or failed: HTTP 404 GET \/repos\/o\/r\/x/);
  assert.match(out, /mirror clone: failed: exit 128/);
  assert.ok(!out.includes(SENTINEL), out);
});
