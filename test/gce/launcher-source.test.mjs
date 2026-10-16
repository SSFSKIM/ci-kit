// Where the launcher's config comes from (gce/launcher/source.mjs, spec §3a Which backend serves a repo): gce.json and
// pool.json on the kit's main, each at the newest commit that changed it; a failed refresh keeps the last good copy
// (and its commit, which the launcher writes on every VM it creates: a stale `ci-kit-config` is how a move sees it);
// before the first success, the copies bundled with the deployed code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createConfigSource } from '../../gce/launcher/source.mjs';

const GCE = JSON.parse(readFileSync(new URL('../../pool/config/gce.json', import.meta.url), 'utf8'));
const SBX = 'SSFSKIM/ci-kit-sandbox';
const MAWS = 'SSFSKIM/MAWS';
const withRepos = (cfg, repos) => JSON.stringify({ ...cfg, repos });

function source({ main, bundled = {} }) {
  const reads = [];
  const gh = {
    lastCommit: async (_repo, path) => {
      const f = main()[path];
      if (f instanceof Error) throw f;
      return f ? { sha: f.sha } : null;
    },
  };
  const fetchText = async (url) => {
    reads.push(url);
    const [, sha, path] = /ci-kit\/([0-9a-f]+)\/(.+)$/.exec(url);
    const f = main()[path];
    if (f instanceof Error || f.sha !== sha) throw new Error('raw read failed');
    return f.text;
  };
  return { reads, load: createConfigSource({ gh, fetchText, readBundled: async (name) => bundled[name] ?? null, bundledCommit: 'b0000000bundled', log: () => {} }) };
}
const sha = (n) => String(n).repeat(40).slice(0, 40);

test('the configs come from main, at the commit that last changed each; a commit already read is not fetched again', async () => {
  const files = {
    'pool/config/gce.json': { sha: sha(1), text: withRepos(GCE, [{ repo: SBX }]) },
    'pool/config/pool.json': { sha: sha(2), text: JSON.stringify({ repos: [{ repo: MAWS, workflows: ['gate.yml'] }] }) },
  };
  const s = source({ main: () => files });
  const got = await s.load();
  assert.deepEqual([got.cfg.repos, got.config, got.poolRepos], [[{ repo: SBX }], sha(1), [MAWS]]);
  await s.load();
  assert.equal(s.reads.length, 2);
});

test('a failed refresh keeps the last good copy and its commit (the stale ci-kit-config a move waits on)', async () => {
  let files = {
    'pool/config/gce.json': { sha: sha(1), text: withRepos(GCE, [{ repo: SBX }]) },
    'pool/config/pool.json': { sha: sha(2), text: JSON.stringify({ repos: [] }) },
  };
  const s = source({ main: () => files });
  await s.load();
  // main moves the sandbox out of gce.json, but this launcher cannot read main.
  files = { 'pool/config/gce.json': new Error('502'), 'pool/config/pool.json': new Error('502') };
  const stale = await s.load();
  assert.deepEqual([stale.cfg.repos, stale.config, stale.poolRepos], [[{ repo: SBX }], sha(1), []]);
});

test('a copy on main that does not parse is not run: the last good copy stays', async () => {
  let files = {
    'pool/config/gce.json': { sha: sha(1), text: withRepos(GCE, [{ repo: SBX }]) },
    'pool/config/pool.json': { sha: sha(2), text: JSON.stringify({ repos: [] }) },
  };
  const s = source({ main: () => files });
  await s.load();
  files = { ...files, 'pool/config/gce.json': { sha: sha(3), text: '{"repos": [' } };
  assert.equal((await s.load()).config, sha(1));
});

test('before any success, the bundled copies, labelled with the deployed commit', async () => {
  const s = source({
    main: () => ({ 'pool/config/gce.json': new Error('down'), 'pool/config/pool.json': new Error('down') }),
    bundled: { 'gce.json': withRepos(GCE, [{ repo: SBX }]), 'pool.json': JSON.stringify({ repos: [{ repo: MAWS, workflows: ['gate.yml'] }] }) },
  });
  const got = await s.load();
  assert.deepEqual([got.cfg.repos, got.config, got.poolRepos], [[{ repo: SBX }], 'b0000000bundled', [MAWS]]);
});

test('a file main does not have (no commit ever changed it) lists no repos', async () => {
  const s = source({ main: () => ({ 'pool/config/gce.json': { sha: sha(1), text: withRepos(GCE, []) }, 'pool/config/pool.json': null }) });
  assert.deepEqual((await s.load()).poolRepos, []);
});
