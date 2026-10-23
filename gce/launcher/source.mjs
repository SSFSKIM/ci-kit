// The launcher's configs from the kit's main, cached by the newest commit that changed each file. Failed or invalid
// reads keep the last good copy (initially the deployed bundle). Confirmed absence is a valid EC2 state, not failure.
import { parseGceConfig, parseEc2Config, resolveRepoProviders } from './config.mjs';

const KIT = 'SSFSKIM/ci-kit';
const GCE_PATH = 'pool/config/gce.json';
const EC2_PATH = 'pool/config/ec2.json';
const POOL_PATH = 'pool/config/pool.json';

// pool.json's repo names, read apart from its operational schema (the Hetzner agent's parser owns that).
export function poolRepos(text) {
  const repos = JSON.parse(text).repos;
  if (!Array.isArray(repos) || !repos.every((r) => typeof r?.repo === 'string')) throw new Error('pool.json has no readable repos list');
  return repos.map((r) => r.repo);
}

const gceConfig = (text) => {
  if (text === null) throw new Error(`${GCE_PATH} is missing`);
  return parseGceConfig(text);
};
const ec2Config = (text) => (text === null ? null : parseEc2Config(text));

// gh: {lastCommit(repo, path)}; fetchText(url) → text or null on confirmed 404; readBundled(name) → text or null.
// load() → {cfg, config, poolRepos, ec2, repoProviders}. cfg.repos retains its original optional providers; resolved
// repoProviders is keyed by repo and includes configured disabled accounts. ec2=null means confirmed absence.
export function createConfigSource({ gh, fetchText, readBundled, bundledCommit, log = () => {} }) {
  const last = new Map(); // path → {commit, value}, successfully parsed
  let active = null; // the last coherent GCE/EC2 pair and its resolved references

  async function bundled(name, parse) {
    let text;
    try {
      text = await readBundled(name);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      text = null;
    }
    return { commit: bundledCommit, value: parse(text) };
  }

  async function read(path, parse, bundledName) {
    try {
      const commit = await gh.lastCommit(KIT, path);
      if (!commit) {
        // No commit on main ever touched it: the file does not exist there.
        last.set(path, { commit: null, value: parse(null) });
      } else if (last.get(path)?.commit !== commit.sha) {
        last.set(path, { commit: commit.sha, value: parse(await fetchText(`https://raw.githubusercontent.com/${KIT}/${commit.sha}/${path}`)) });
      }
    } catch (err) {
      if (last.has(path)) {
        log(`config: keeping ${path} at ${last.get(path).commit?.slice(0, 8)} (${err.message})`);
      } else {
        log(`config: running the bundled ${path} (${err.message})`);
        last.set(path, await bundled(bundledName, parse));
      }
    }
    return last.get(path);
  }

  function resolve(gce, ec2) {
    // Repeated ticks of the same config do not repeat absent-account warnings.
    if (active?.gce.value === gce.value && active.ec2.value === ec2.value) return active.repoProviders;
    return resolveRepoProviders(gce.value, ec2.value, { log });
  }

  return async function load() {
    let [gce, ec2, pool] = await Promise.all([
      read(GCE_PATH, gceConfig, 'gce.json'),
      read(EC2_PATH, ec2Config, 'ec2.json'),
      read(POOL_PATH, (text) => (text === null ? [] : poolRepos(text)), 'pool.json'),
    ]);
    let repoProviders;
    try {
      repoProviders = resolve(gce, ec2);
    } catch (err) {
      log(`config: keeping coherent provider references (${err.message})`);
      // A bad repo-list edit cannot pin EC2 to its last enabled state: first try the previous good repo config with
      // the latest accounts. If the accounts themselves invalidated references, retain the previous coherent pair.
      gce = active?.gce ?? await bundled('gce.json', gceConfig);
      try {
        repoProviders = resolve(gce, ec2);
      } catch {
        if (!active) throw err;
        ec2 = active.ec2;
        repoProviders = active.repoProviders;
      }
      last.set(GCE_PATH, gce);
      last.set(EC2_PATH, ec2);
    }
    active = { gce, ec2, repoProviders };
    return { cfg: gce.value, config: gce.commit, poolRepos: pool.value, ec2: ec2.value, repoProviders };
  };
}
