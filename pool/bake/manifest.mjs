// A bake resolves moving inputs once, then every cloud builds these exact inputs.
import { parseConfig } from '../../plan/config.mjs';
import { setupHash } from '../../setup/hash.mjs';

export const repoSlug = repo => repo.toLowerCase().replace(/[^a-z0-9-]/g, '-');
export const jobImage = repo => `ci-kit-job/${repoSlug(repo)}:latest`;
export function bakeScope(repos) {
  const groups = new Map();
  for (const { repo } of repos) {
    const [owner, name] = repo.split('/'), key = owner.toLowerCase();
    if (!groups.has(key)) groups.set(key, { repo, scope: { repositories: [], permissions: { contents: 'read' } } });
    const names = groups.get(key).scope.repositories;
    if (!names.includes(name)) names.push(name);
  }
  return Object.fromEntries(groups);
}

const canonical = (value) => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v);

export async function resolveManifest({ sha, gh, repos = [], fetch: fetcher = globalThis.fetch }) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('bake manifest needs an exact kit commit');
  const res = await fetcher('https://nodejs.org/dist/index.json', { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error('cannot resolve Node versions');
  const index = await res.json();
  const node = Object.fromEntries([22, 24].map((major) => [major, index.find((v) => v.version.startsWith(`v${major}.`))?.version]));
  if (Object.values(node).some((v) => !/^v\d+\.\d+\.\d+$/.test(v))) throw new Error('missing Node version');
  // ci-kit is public; the served repositories' installation token is not sent to public reads.
  const source = await fetcher(`https://raw.githubusercontent.com/SSFSKIM/ci-kit/${sha}/pool/image/Dockerfile`, { signal: AbortSignal.timeout(60_000) });
  if (!source.ok) throw new Error('cannot read pinned runner Dockerfile');
  const dockerfile = await source.text();
  const runner_version = /FROM ghcr\.io\/actions\/actions-runner:(\d+\.\d+\.\d+)@sha256:/.exec(dockerfile)?.[1];
  if (!runner_version) throw new Error('runner image must pin its version and digest');
  const resolved = await resolveRepos({ gh, repos });
  return { v: 1, kit_commit: sha, node, runner_version, repos: resolved };
}

// Shared by the bake and its hourly stale check: read config and script at one default-branch revision.
// No config (404) or no declaration means no job image. Other read/validation failures propagate.
export async function resolveRepos({ gh, repos }) {
  const raw = { accept: 'application/vnd.github.raw+json', text: true };
  const resolved = {}, identities = new Set();
  for (const { repo } of repos) {
    const slug = repoSlug(repo);
    if (`ci-kit-setup-${slug}`.length > 63 || identities.has(slug)) throw new Error(`unsupported or colliding image identity: ${repo}`);
    identities.add(slug);
    const pinned = (await gh.request('GET', `/repos/${repo}/commits/HEAD`)).sha;
    if (!/^[a-f0-9]{40}$/.test(pinned)) throw new Error(`cannot resolve ${repo} revision`);
    let text;
    try { text = await gh.request('GET', `/repos/${repo}/contents/.github/ci-kit.yml?ref=${pinned}`, raw); }
    catch (error) { if (error.status === 404) continue; throw error; }
    const { setup } = parseConfig(text, { isPrivate: true });
    const scriptPath = setup.script.split('/').map(encodeURIComponent).join('/');
    const bytes = setup.script ? await gh.request('GET', `/repos/${repo}/contents/${scriptPath}?ref=${pinned}`, { accept: raw.accept, bytes: true }) : undefined;
    const hash = setupHash(setup, bytes);
    if (hash !== 'none') resolved[repo] = { revision: pinned, setup_hash: hash };
  }
  return resolved;
}

export function verifyManifest(actual, expected) {
  const { repos, ...pins } = actual ?? {};
  const { repos: expectedRepos, ...expectedPins } = expected;
  const repoPins = entries => entries === undefined ? undefined : Object.fromEntries(Object.entries(entries).map(([repo, entry]) => {
    const { apply, warm, ...pin } = entry ?? {};
    return [repo, pin];
  }));
  if (canonical(pins) !== canonical(expectedPins) || canonical(repoPins(repos)) !== canonical(repoPins(expectedRepos))) throw new Error('builder manifest differs from resolved inputs');
  verifyRepoResults(repos);
  return actual;
}

export function verifyRepoResults(repos = {}) {
  if (!repos || Array.isArray(repos) || typeof repos !== 'object') throw new Error('invalid repos manifest');
  for (const [repo, entry] of Object.entries(repos)) {
    if (!/^[a-f0-9]{40}$/.test(entry?.revision) || !/^[a-f0-9]{16}$/.test(entry?.setup_hash) ||
        entry?.apply?.ok !== true || !Number.isSafeInteger(entry.apply.image_bytes) || entry.apply.image_bytes < 0 ||
        typeof entry?.warm?.ok !== 'boolean') throw new Error(`${repo}: builder apply results incomplete or failed`);
  }
}

export function logRepoResults(manifest, log) {
  for (const [repo, entry] of Object.entries(manifest.repos ?? {})) {
    log(`bake: ${repo} setup ${entry.setup_hash}: apply ok (metadata refused; clone credentials absent); ${entry.apply.image_bytes} bytes above base; warm ${entry.warm.ok ? 'ok' : 'FAILED (best effort)'}`);
  }
}

export function manifestTags(manifest) {
  return { ...manifestLabels(manifest), ...Object.fromEntries(Object.entries(manifest.repos ?? {}).map(([repo, entry]) => [`ci-kit-setup:${repo}`, entry.setup_hash])) };
}

// GCE label values allow 63 characters and no dots.
export function manifestLabels(manifest) {
  return {
    'ci-kit-commit': manifest.kit_commit,
    'ci-kit-node-22': manifest.node[22].replaceAll('.', '_'),
    'ci-kit-node-24': manifest.node[24].replaceAll('.', '_'),
    'ci-kit-runner': manifest.runner_version.replaceAll('.', '_'),
    ...Object.fromEntries(Object.entries(manifest.repos ?? {}).map(([repo, entry]) => [`ci-kit-setup-${repoSlug(repo)}`, entry.setup_hash])),
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
