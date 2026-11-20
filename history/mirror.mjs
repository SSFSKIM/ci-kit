// The mirror (gate ledger spec, Glossary "The mirror" and "Tree key"): a bare clone of a served repository without file
// contents, made with the collection's token. Trees, ancestry and path differences are read from it; a commit no ref
// reaches any more (a ci-gate's nonce commit, a pull request's head) is fetched into it by id. The token travels as
// an extra header in the environment, never on a command line, and lazy fetches are off, so a read that would need a
// file's contents fails instead of downloading it. Its errors name the git command and its exit status, never git's
// stderr, which can quote a path or a ref of a private repository.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SHA = /^[0-9a-f]{40}$/;

// dir: the bare clone's directory; url: the remote (https://github.com/<repo>.git by default); token: a string or null.
export function openMirror({ dir, repo = null, url = `https://github.com/${repo}.git`, token = null }) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' };
  if (token) {
    Object.assign(env, {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    });
  }
  const run = (args, { inDir = true } = {}) => {
    const r = spawnSync('git', inDir ? ['-C', dir, ...args] : args, { env, encoding: 'utf8', maxBuffer: 1 << 28 });
    return { ok: r.status === 0, out: r.stdout ?? '', status: r.status ?? r.signal ?? r.error?.code ?? null };
  };
  const must = (args) => {
    const r = run(args);
    if (!r.ok) throw new Error(`history: git ${args[0]} failed in the mirror (exit ${r.status})`);
    return r.out;
  };
  const keys = new Map(); // tree:policy → key

  const mirror = {
    // Clones once; a mirror already on disk is used as it is.
    ensure() {
      if (existsSync(dir)) return;
      mkdirSync(dirname(dir), { recursive: true });
      const r = run(['clone', '--quiet', '--bare', '--filter=blob:none', url, dir], { inDir: false });
      if (!r.ok) throw new Error(`history: the mirror clone failed (exit ${r.status})`);
    },
    has: (sha) => SHA.test(sha ?? '') && run(['cat-file', '-e', `${sha}^{commit}`]).ok,
    // Fetches the commits it lacks in one request; a request refused because one id is gone is split in halves, so
    // that id spoils no other and costs a few requests, not one per id. → the ids now present.
    fetch(shas) {
      const wanted = [...new Set(shas.filter((s) => SHA.test(s ?? '')))];
      const get = (ids) => {
        if (ids.length === 0 || run(['fetch', '--quiet', '--no-tags', '--filter=blob:none', 'origin', ...ids]).ok || ids.length === 1) return;
        get(ids.slice(0, ids.length >> 1));
        get(ids.slice(ids.length >> 1));
      };
      get(wanted.filter((s) => !mirror.has(s)));
      return new Set(wanted.filter((s) => mirror.has(s)));
    },
    // A commit's one parent, or null (absent, a root, or a merge).
    parentOf(sha) {
      if (!mirror.has(sha)) return null;
      const parents = must(['rev-list', '--parents', '-n', '1', sha]).trim().split(' ').slice(1);
      return parents.length === 1 ? parents[0] : null;
    },
    // A tree's identity for comparing landed and gated trees: the tree id without a policy; under one ({ exclude,
    // except }: directory prefixes), the hash of the tree's entries with the excluded paths removed and the
    // exceptions kept. Only the directories on a policy's paths are read.
    treeKey(tree, policy) {
      if (!policy) return tree;
      const memo = `${tree}:${JSON.stringify(policy)}`;
      if (keys.has(memo)) return keys.get(memo);
      const { exclude, except = [] } = policy;
      const out = [];
      const walk = (id, prefix) => {
        for (const row of must(['ls-tree', '-z', id]).split('\0').filter(Boolean)) {
          const [meta, name] = row.split('\t');
          const [mode, type, oid] = meta.split(' ');
          const p = `${prefix}${name}${type === 'tree' ? '/' : ''}`;
          const excluded = exclude.some((x) => p.startsWith(x)) && !except.some((x) => p.startsWith(x));
          const below = (list) => type === 'tree' && list.some((x) => x.startsWith(p) && x !== p);
          if (excluded) {
            if (below(except)) walk(oid, p);
          } else if (below(exclude)) walk(oid, p);
          else out.push(`${mode} ${type} ${oid} ${p}`);
        }
      };
      walk(tree, '');
      const key = createHash('sha256').update(out.sort().join('\n')).digest('hex');
      keys.set(memo, key);
      return key;
    },
    // The paths that differ between two trees or commits (neither need descend from the other); a rename counts
    // under both its names.
    paths: (a, b) => [...new Set(must(['diff-tree', '-r', '--no-renames', '--name-only', '-z', a, b]).split('\0').filter(Boolean))].sort(),
    isAncestor: (a, b) => run(['merge-base', '--is-ancestor', a, b]).ok,
  };
  return mirror;
}
