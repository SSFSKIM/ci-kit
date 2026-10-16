// The bake's pure parts (spec §3 Bake): what its cleanup may delete, what pruning removes, and the builder's
// user-data. Only resources carrying the kit's labels are ever selected.
import { hasKitLabel } from '../../lib/hcloud.mjs';
import { candidates, poolFirewall, CORE_LIMIT } from '../lib/ensure.mjs';

const LIMIT_RETRY_EVERY = 5 * 60_000;
const LIMIT_RETRY_FOR = 2 * 3600_000;

export class CoreLimitError extends Error {}

// Create the bake's builder. The project's core limit (a pool box up, with other work's servers) refuses it
// project-wide, so one attempt is made per round and the round is retried every 5 min for at most 2 h; then
// CoreLimitError, which the bake turns into an alert (spec Decision Log: the pool degrades gracefully).
export async function createBuilder(hc, { userData, runId, builder, sleep, now = Date.now, log = () => {} }) {
  const start = now();
  for (;;) {
    const tried = [];
    let limited = false;
    for (const { type, location } of candidates(builder, await hc.serverTypes())) {
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
          limited = true;
          break;
        }
        if (err.code !== 'resource_unavailable' && err.code !== 'placement_error') throw err;
      }
    }
    if (!limited) throw new Error(`ci-kit: no builder type available: ${tried.join(', ')}`);
    if (now() - start >= LIMIT_RETRY_FOR) {
      throw new CoreLimitError(`ci-kit: the Hetzner project's core limit refused the bake's builder for 2 h (a pool box up, or other servers in the project)`);
    }
    log(`the project's core limit refused the builder; retrying in 5 min (waiting ${Math.round((now() - start) / 60_000)} of at most 120 min)`);
    await sleep(LIMIT_RETRY_EVERY);
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
