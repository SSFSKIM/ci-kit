// A bake resolves moving inputs once, then every cloud builds these exact inputs.
import { createHash } from 'node:crypto';

export const digest = (text) => createHash('sha256').update(text).digest('hex');
const canonical = (value) => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v);

export async function resolveManifest({ sha, gh, fetch: fetcher = globalThis.fetch }) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('bake manifest needs an exact kit commit');
  const res = await fetcher('https://nodejs.org/dist/index.json', { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error('cannot resolve Node versions');
  const index = await res.json();
  const node = Object.fromEntries([22, 24].map((major) => [major, index.find((v) => v.version.startsWith(`v${major}.`))?.version]));
  if (Object.values(node).some((v) => !/^v\d+\.\d+\.\d+$/.test(v))) throw new Error('missing Node version');
  const { sha: revision } = await gh.request('GET', '/repos/SSFSKIM/MAWS/commits/HEAD');
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('cannot resolve MAWS revision');
  const raw = { accept: 'application/vnd.github.raw+json', text: true };
  const lock = await gh.request('GET', `/repos/SSFSKIM/MAWS/contents/pnpm-lock.yaml?ref=${revision}`, raw);
  // ci-kit is public; the restricted MAWS installation token need not grant it access.
  const source = await fetcher(`https://raw.githubusercontent.com/SSFSKIM/ci-kit/${sha}/pool/image/Dockerfile`, { signal: AbortSignal.timeout(60_000) });
  if (!source.ok) throw new Error('cannot read pinned runner Dockerfile');
  const dockerfile = await source.text();
  const runner_version = /FROM ghcr\.io\/actions\/actions-runner:(\d+\.\d+\.\d+)@sha256:/.exec(dockerfile)?.[1];
  if (!runner_version) throw new Error('runner image must pin its version and digest');
  return { v: 1, kit_commit: sha, node, maws: { revision, lock_sha256: digest(lock) }, runner_version };
}

export function verifyManifest(actual, expected) {
  const { warm, ...pins } = actual ?? {};
  const { warm: expectedWarm, ...expectedPins } = expected;
  if (canonical(pins) !== canonical(expectedPins)) throw new Error('builder manifest differs from resolved inputs');
  if (!warm?.['maws-files']?.ok || !warm?.['pnpm-fetch']?.ok || Object.values(warm).some((r) => r.ok !== true)) throw new Error('builder warm results incomplete or failed');
  if (expectedWarm && canonical(warm) !== canonical(expectedWarm)) throw new Error('builder warm results differ between clouds');
  return actual;
}

// GCE label values allow 63 characters and no dots; split SHA256, never truncate it.
export function manifestLabels(manifest) {
  const warm = digest(canonical(manifest.warm));
  return {
    'ci-kit-commit': manifest.kit_commit,
    'ci-kit-node-22': manifest.node[22].replaceAll('.', '_'),
    'ci-kit-node-24': manifest.node[24].replaceAll('.', '_'),
    'ci-kit-maws-revision': manifest.maws.revision,
    'ci-kit-maws-lock-a': manifest.maws.lock_sha256.slice(0, 32),
    'ci-kit-maws-lock-b': manifest.maws.lock_sha256.slice(32),
    'ci-kit-runner': manifest.runner_version.replaceAll('.', '_'),
    'ci-kit-warm-a': warm.slice(0, 32), 'ci-kit-warm-b': warm.slice(32),
  };
}

// Isolate provider failures: a failed cloud keeps its previous ready image, while others still bake.
export async function bakeProviders({ resolve, gce, accounts, ec2 }) {
  const manifest = await resolve();
  const results = [], failures = [];
  let expected = manifest;
  try { const result = await gce(manifest); expected = result.manifest; results.push(result); }
  catch (error) { failures.push(error); }
  for (const account of accounts) {
    try { const result = await ec2(account, expected); expected = result.manifest; results.push(result); }
    catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, failures.map((e) => e.message).join('; '));
  return results;
}
