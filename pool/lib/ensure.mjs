// Ensure (spec §3 Ensure, I7): make sure a pool box exists, without waiting for it to boot.
// The linearization point is the server name `ci-kit-pool`: of two concurrent ensures, Hetzner lets one create it.
// Only resources carrying a `ci-kit=` label are ever looked at; the project holds other work's resources.
import { hasKitLabel } from '../../lib/hcloud.mjs';

export const POOL_NAME = 'ci-kit-pool';
const DRAIN_WAIT_MS = 3 * 60_000;
const NEXT_PAIR = new Set(['resource_unavailable', 'placement_error']);

export const poolServers = (servers) => servers.filter((s) => hasKitLabel(s, 'pool'));

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

export async function poolFirewall(hc) {
  const mine = (await hc.firewalls('ci-kit=pool')).find((f) => hasKitLabel(f, 'pool') && f.name === POOL_NAME);
  if (mine) return mine;
  // No inbound rules: Hetzner firewalls drop all inbound traffic not allowed by a rule (spec §3 Isolation).
  return hc.createFirewall({ name: POOL_NAME, labels: { 'ci-kit': 'pool' }, rules: [] });
}

// Returns 'existing' | 'created:<type>@<location>' | 'raced' (I7). Throws when every pair is unavailable,
// when there is no pool snapshot, or on any other API error (a rejected token among them).
export async function ensure(hc, cfg, { sleep, now = Date.now, log = () => {}, userData } = {}) {
  let decision = ensureDecision(poolServers(await hc.servers('ci-kit=pool')));
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
  const pairs = candidates(cfg, await hc.serverTypes());
  const tried = [];
  for (const { type, location } of pairs) {
    tried.push(`${type}@${location}`);
    try {
      await hc.createServer({
        name: POOL_NAME,
        server_type: type,
        location,
        image: image.id,
        firewalls: [{ firewall: firewall.id }],
        labels: { 'ci-kit': 'pool', 'ci-kit-state': 'booting' },
        ...(userData ? { user_data: userData } : {}),
      });
      log(`created ${POOL_NAME} (${type}@${location}) from snapshot ${image.id}`);
      return `created:${type}@${location}`;
    } catch (err) {
      if (err.code === 'uniqueness_error') {
        if (poolServers(await hc.servers('ci-kit=pool')).length > 0) return 'raced';
        throw new Error(`ci-kit: a server named ${POOL_NAME} exists without the ci-kit=pool label; it is not the kit's to touch`);
      }
      if (!NEXT_PAIR.has(err.code)) throw err;
      log(`${type}@${location}: ${err.code}; trying the next pair`);
    }
  }
  throw new Error(`ci-kit: no pool server type is available: ${tried.join(', ') || 'none of the preferences is offered'}`);
}
