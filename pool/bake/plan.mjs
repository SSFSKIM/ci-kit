// The bake's pure parts (spec §3 Bake): what its cleanup may delete, what pruning removes, and the builder's
// user-data. Only resources carrying the kit's labels are ever selected.
import { hasKitLabel } from '../../lib/hcloud.mjs';

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
