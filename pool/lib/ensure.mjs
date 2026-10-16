// Ensure (spec §3 Ensure, I7): make sure a pool box exists, without waiting for it to boot.
// The linearization point is the server name `ci-kit-pool`: of two concurrent ensures, Hetzner lets one create it.
// Only resources carrying a `ci-kit=` label are ever looked at; the project holds other work's resources.
import { hasKitLabel } from '../../lib/hcloud.mjs';

export const POOL_NAME = 'ci-kit-pool';
const DRAIN_WAIT_MS = 3 * 60_000;
const NEXT_PAIR = new Set(['resource_unavailable', 'placement_error']);
// The project's core limit, seen live: `403 resource_limit_exceeded (shared core limit exceeded)`.
export const CORE_LIMIT = 'resource_limit_exceeded';

export const poolServers = (servers) => servers.filter((s) => hasKitLabel(s, 'pool'));

// Stamp a pool box with `ci-kit-want=<now>`: pool demand is coming, and its agent holds the box for 15 min (spec
// Decision Log, 2026-10-16). A read-modify-write of the labels as they are now, on a box that still carries
// ci-kit=pool; Hetzner replaces the whole set on a write. A stamp lost to a racing write costs nothing lasting: the
// pool jobs this call was for keep the box once they queue.
export async function stampWant(hc, serverId, nowMs) {
  const current = await hc.server(serverId);
  if (!hasKitLabel(current, 'pool')) return false;
  await hc.setLabels(serverId, { ...current.labels, 'ci-kit-want': String(Math.floor(nowMs / 1000)) });
  return true;
}

// The backend that serves `repo` (spec §3a, Which backend serves a repo; I12): 'gce' for a repo in gce.json,
// 'hetzner' for one in pool.json, 'none' for one in neither (a repo in transit between backends). gce.json is checked
// first, as §3a orders it; a repo in both is a config error the planner's config test and the launcher refuse.
export function backendOf(repo, poolRepos, gceRepos) {
  const has = (list) => list.some((r) => r.toLowerCase() === repo.toLowerCase());
  if (has(gceRepos)) return 'gce';
  return has(poolRepos) ? 'hetzner' : 'none';
}

// The repos a kit config file lists. Membership is read on its own terms, apart from the file's operational schema,
// so a copy on main that this version's parser would reject still says which repos it serves.
function reposOf(text, where) {
  let repos;
  try {
    repos = JSON.parse(text).repos;
  } catch {
    repos = null;
  }
  if (!Array.isArray(repos) || !repos.every((r) => typeof r?.repo === 'string')) {
    throw new Error(`ci-kit: ${where} has no readable repos list; ensure touches nothing in Hetzner until it is fixed`);
  }
  return repos.map((r) => r.repo);
}

// Which repos a kit config file (`name`) lists. The kit's main decides whenever it answered: absent there (404) is no
// repos, and a copy whose repos cannot be read refuses rather than falling back, since the bundled list may still
// hold a repo main has moved (spec §3a). Only when main cannot be reached is the bundled copy read; readBundled
// resolves null when this version bundles no such file.
export async function kitRepos(name, { fetchMain, readBundled }) {
  let text;
  try {
    text = await fetchMain();
  } catch (err) {
    if (err.status === 404) return [];
    const bundled = await readBundled();
    return bundled === null ? [] : reposOf(bundled, `the bundled ${name}`);
  }
  return reposOf(text, `${name} on the kit's main`);
}

// The operational pool config (types, locations, …) as the kit's main has it, else this version's bundled copy (also
// when main's copy does not parse with this version's parser), else null. It never decides membership: kitRepos does.
export async function kitConfig(parse, { fetchMain, readBundled }) {
  try {
    return parse(await fetchMain());
  } catch {
    try {
      return parse(await readBundled());
    } catch {
      return null;
    }
  }
}

// The ensure action for the calling repo (I7, I12): 'gce' or 'none' for a repo the Hetzner pool does not serve, with
// no Hetzner token needed and nothing in Hetzner touched; else ensure's own result. pool and gce: {fetchMain,
// readBundled} for pool/config/pool.json and gce.json.
export async function ensureForCaller({ repo, token, pool, gce, parsePool, createHcloud, opts }) {
  const gceRepos = await kitRepos('gce.json', gce);
  if (backendOf(repo, [], gceRepos) === 'gce') return 'gce';
  const backend = backendOf(repo, await kitRepos('pool.json', pool), gceRepos);
  if (backend !== 'hetzner') return backend;
  if (!token?.trim()) throw new Error('ci-kit: the pool needs the HCLOUD_TOKEN secret (pool-ensure input hcloud-token)');
  const cfg = await kitConfig(parsePool, pool);
  if (!cfg) throw new Error('ci-kit: the pool config could not be read from the kit\'s main or its bundled copy');
  return ensure(createHcloud(token.trim()), cfg, opts);
}

// 'existing' when a box is booting or ready, 'wait' when the only box is draining, else 'create'.
export function ensureDecision(pool) {
  if (pool.length === 0) return 'create';
  if (pool.every((s) => s.labels['ci-kit-state'] === 'draining')) return 'wait';
  return 'existing';
}

// The (type, location) pairs to try, in preference order, that server_types says are available.
export function candidates(cfg, serverTypes) {
  const pairs = [];
  for (const type of cfg.types) {
    const st = serverTypes.find((t) => t.name === type);
    if (!st) continue;
    for (const location of cfg.locations) {
      if (st.locations?.some((l) => l.name === location && l.available)) pairs.push({ type, location });
    }
  }
  return pairs;
}

export function newestImage(images) {
  return images
    .filter((i) => hasKitLabel(i, 'pool-image') && i.type === 'snapshot' && i.status === 'available')
    .sort((a, b) => Date.parse(b.created) - Date.parse(a.created))[0] ?? null;
}

const ownFirewall = async (hc) => (await hc.firewalls('ci-kit=pool')).find((f) => hasKitLabel(f, 'pool') && f.name === POOL_NAME);

export async function poolFirewall(hc) {
  const mine = await ownFirewall(hc);
  if (mine) return mine;
  try {
    // No inbound rules: Hetzner firewalls drop all inbound traffic not allowed by a rule (spec §3 Isolation).
    return await hc.createFirewall({ name: POOL_NAME, labels: { 'ci-kit': 'pool' }, rules: [] });
  } catch (err) {
    if (err.code !== 'uniqueness_error') throw err;
    // Another first ensure created it between our list and our create: use theirs, if it is the kit's.
    const theirs = await ownFirewall(hc);
    if (theirs) return theirs;
    throw new Error(`ci-kit: a firewall named ${POOL_NAME} exists without the ci-kit=pool label; it is not the kit's to touch`);
  }
}

// Returns 'existing' | 'created:<type>@<location>' | 'raced' (I7). Throws when every pair is unavailable,
// when there is no pool snapshot, or on any other API error (a rejected token among them).
// The core limit is the project's, not a location's: a type refused for it is not tried elsewhere, and the walk
// moves on to `fallback_types` (smaller boxes). A box made that way carries `ci-kit-fallback=core-limit`, which
// its agent turns into an alert; `warn` reports it in the calling workflow. Jobs asking for more cores than a
// smaller box run on all its cores once it is otherwise empty (clamped; logic.mjs planStarts).
export async function ensure(hc, cfg, { sleep, now = Date.now, log = () => {}, warn = log, userData } = {}) {
  const found = poolServers(await hc.servers('ci-kit=pool'));
  // Every box found is stamped, a draining one too: its agent sees the stamp at its re-check and returns to ready.
  for (const s of found) {
    try {
      await stampWant(hc, s.id, now());
    } catch (err) {
      warn(`ci-kit pool: could not stamp ${s.name} (${s.id}) with ci-kit-want: ${err.message}`);
    }
  }
  let decision = ensureDecision(found);
  if (decision === 'wait') {
    log('a draining pool box exists; waiting for it to be gone (at most 3 min)');
    const start = now();
    while (decision === 'wait' && now() - start < DRAIN_WAIT_MS) {
      await sleep(10_000);
      decision = ensureDecision(poolServers(await hc.servers('ci-kit=pool')));
    }
    if (decision === 'wait') decision = 'create';
  }
  if (decision === 'existing') return 'existing';

  const image = newestImage(await hc.images('ci-kit=pool-image'));
  if (!image) throw new Error('ci-kit: no snapshot labelled ci-kit=pool-image; run the bake (pool-bake.yml)');
  const firewall = await poolFirewall(hc);
  const serverTypes = await hc.serverTypes();
  const tried = [];
  const limited = [];
  const walk = async (types, labels) => {
    for (const { type, location } of candidates({ ...cfg, types }, serverTypes)) {
      if (limited.includes(type)) continue;
      tried.push(`${type}@${location}`);
      try {
        await hc.createServer({
          name: POOL_NAME,
          server_type: type,
          location,
          image: image.id,
          firewalls: [{ firewall: firewall.id }],
          labels: { ...labels, 'ci-kit-want': String(Math.floor(now() / 1000)) },
          ...(userData ? { user_data: userData } : {}),
        });
        log(`created ${POOL_NAME} (${type}@${location}) from snapshot ${image.id}`);
        return `created:${type}@${location}`;
      } catch (err) {
        if (err.code === 'uniqueness_error') {
          if (poolServers(await hc.servers('ci-kit=pool')).length > 0) return 'raced';
          throw new Error(`ci-kit: a server named ${POOL_NAME} exists without the ci-kit=pool label; it is not the kit's to touch`);
        }
        if (err.code === CORE_LIMIT) {
          limited.push(type);
          log(`${type}: refused for the project's core limit`);
          continue;
        }
        if (!NEXT_PAIR.has(err.code)) throw err;
        log(`${type}@${location}: ${err.code}; trying the next pair`);
      }
    }
    return null;
  };

  const preferred = await walk(cfg.types, { 'ci-kit': 'pool', 'ci-kit-state': 'booting' });
  if (preferred) return preferred;
  if (limited.length && cfg.fallback_types?.length) {
    const fallback = await walk(cfg.fallback_types, { 'ci-kit': 'pool', 'ci-kit-state': 'booting', 'ci-kit-fallback': 'core-limit' });
    if (fallback) {
      warn(`ci-kit pool: the project's core limit refused ${limited.join(', ')}; created a smaller box (${fallback.slice('created:'.length)}). Gates asking for more cores than it has run clamped to it.`);
      return fallback;
    }
  }
  if (limited.length) throw new Error(`ci-kit: the Hetzner project's core limit refused every pool type: ${limited.join(', ')}`);
  throw new Error(`ci-kit: no pool server type is available: ${tried.join(', ') || 'none of the preferences is offered'}`);
}
