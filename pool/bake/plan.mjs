// The bake's pure parts (spec §3 Bake): what its cleanup may delete, what pruning removes, and the builder's
// user-data. Only resources carrying the kit's labels are ever selected.
import { hasKitLabel } from '../../lib/hcloud.mjs';
import { candidates, poolFirewall, CORE_LIMIT } from '../lib/ensure.mjs';

const BLOCKED_RETRY_EVERY = 15 * 60_000;
const BLOCKED_RETRY_FOR = 2 * 3600_000;

// The smallest types that hold the image build, smallest first: cpx12 (1 vCPU, 2 GB; the builder adds 2 GB of
// swap), then the 2-vCPU types. Each has a 40 GB disk except cpx22 (80), and a snapshot boots only on a type with
// at least its disk, so the 40 GB ones come first (spec Decision Log: the kit lives within the core limit).
export const BUILDER_TYPES = ['cpx12', 'cx23', 'cpx22'];

export class BakeBlockedError extends Error {}

// Create the bake's builder. The project's core limit leaves no room for one while a pool box is up, so the bake
// waits while a pool box exists, and a create refused for the limit (project-wide: one attempt per round) waits
// too; it tries again every 15 min for at most 2 h, then throws BakeBlockedError, which the bake turns into an
// alert. The previous snapshots stay in use.
export async function createBuilder(hc, { userData, runId, builder, sleep, now = Date.now, log = () => {} }) {
  const start = now();
  for (;;) {
    let blocked = null;
    const pool = (await hc.servers('ci-kit=pool')).filter((s) => hasKitLabel(s, 'pool'));
    if (pool.length) blocked = `a pool box is up (${pool.map((s) => s.id).join(', ')})`;
    const tried = [];
    for (const { type, location } of blocked ? [] : candidates(builder, await hc.serverTypes())) {
      tried.push(`${type}@${location}`);
      try {
        const { server } = await hc.createServer({
          name: `ci-kit-builder-${runId}`,
          server_type: type,
          location,
          image: 'ubuntu-24.04',
          firewalls: [{ firewall: (await poolFirewall(hc)).id }],
          labels: { 'ci-kit': 'builder', 'ci-kit-run': String(runId) },
          user_data: userData,
        });
        log(`builder ${server.id} (${type}@${location}) created`);
        return server;
      } catch (err) {
        if (err.code === CORE_LIMIT) {
          blocked = "the project's core limit refused the builder";
          break;
        }
        if (err.code !== 'resource_unavailable' && err.code !== 'placement_error') throw err;
      }
    }
    if (!blocked) throw new Error(`ci-kit: no builder type available: ${tried.join(', ')}`);
    if (now() - start >= BLOCKED_RETRY_FOR) {
      throw new BakeBlockedError(`ci-kit: the bake could not create its builder for 2 h: ${blocked}`);
    }
    log(`${blocked}; retrying in 15 min (waited ${Math.round((now() - start) / 60_000)} of at most 120 min)`);
    await sleep(BLOCKED_RETRY_EVERY);
  }
}

// What a bake run leaves when it does not complete: its builders, and snapshots it started that never became
// available. Matched by the run id label, so concurrent or earlier bakes are never touched.
export function bakeLeftovers({ servers, images, runId }) {
  const ours = (r) => r.labels?.['ci-kit-run'] === String(runId);
  return {
    servers: servers.filter((s) => hasKitLabel(s, 'builder') && ours(s)),
    images: images.filter((i) => hasKitLabel(i, 'pool-image') && ours(i) && i.status !== 'available'),
  };
}

// Available pool snapshots beyond the `keep` newest.
export function snapshotsToPrune(images, keep) {
  return images
    .filter((i) => hasKitLabel(i, 'pool-image') && i.type === 'snapshot' && i.status === 'available')
    .sort((a, b) => Date.parse(b.created) - Date.parse(a.created))
    .slice(keep);
}

// Fills the builder template's placeholders. Every placeholder must be known: a missed one would bake a broken
// image, and a value is never interpolated by the shell (the template quotes its heredocs).
export function builderUserData(template, { sha, appId, appKey, hcloudToken }) {
  const values = { __KIT_SHA__: sha, __APP_ID__: String(appId), __APP_KEY__: appKey.trim(), __HCLOUD_TOKEN__: hcloudToken.trim() };
  const out = template.replace(/__[A-Z_]+__/g, (name) => {
    if (!(name in values)) throw new Error(`ci-kit: builder template has an unknown placeholder ${name}`);
    return values[name];
  });
  return out;
}
