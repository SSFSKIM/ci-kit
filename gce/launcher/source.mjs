// The configs the launcher runs (spec §3a Which backend serves a repo): pool/config/gce.json, and pool.json's repo
// list for the one-file-per-repo rule, from the kit's main. Each is read at the newest commit that changed it (a raw
// read of a commit is never a stale cached copy of main) and kept by commit. A failed or unparsable read keeps the
// last good copy; before the first, the copy bundled with the deployed code, labelled with that code's commit.
import { parseGceConfig } from './config.mjs';

const KIT = 'SSFSKIM/ci-kit';
const GCE_PATH = 'pool/config/gce.json';
const POOL_PATH = 'pool/config/pool.json';

// pool.json's repo names, read apart from its operational schema (the Hetzner agent's parser owns that).
function poolRepos(text) {
  const repos = JSON.parse(text).repos;
  if (!Array.isArray(repos) || !repos.every((r) => typeof r?.repo === 'string')) throw new Error('pool.json has no readable repos list');
  return repos.map((r) => r.repo);
}

// gh: {lastCommit(repo, path)}; fetchText(url); readBundled(name) → text or null. Returns load() → {cfg, config,
// poolRepos}: the gce.json config, its commit, and pool.json's repo names.
export function createConfigSource({ gh, fetchText, readBundled, bundledCommit, log = () => {} }) {
  const last = new Map(); // path → {commit, value}

  async function read(path, parse, bundledName) {
    try {
      const commit = await gh.lastCommit(KIT, path);
      if (!commit) {
        // No commit on main ever touched it: the file does not exist there.
        const value = parse(null);
        last.set(path, { commit: null, value });
        return last.get(path);
      }
      if (last.get(path)?.commit !== commit.sha) {
        last.set(path, { commit: commit.sha, value: parse(await fetchText(`https://raw.githubusercontent.com/${KIT}/${commit.sha}/${path}`)) });
      }
    } catch (err) {
      if (last.has(path)) {
        log(`config: keeping ${path} at ${last.get(path).commit?.slice(0, 8)} (${err.message})`);
      } else {
        log(`config: running the bundled ${path} (${err.message})`);
        last.set(path, { commit: bundledCommit, value: parse(await readBundled(bundledName)) });
      }
    }
    return last.get(path);
  }

  return async function load() {
    const gce = await read(GCE_PATH, (text) => {
      if (text === null) throw new Error(`${GCE_PATH} is missing`);
      return parseGceConfig(text);
    }, 'gce.json');
    const pool = await read(POOL_PATH, (text) => (text === null ? [] : poolRepos(text)), 'pool.json');
    return { cfg: gce.value, config: gce.commit, poolRepos: pool.value };
  };
}
