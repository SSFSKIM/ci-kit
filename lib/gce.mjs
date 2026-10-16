// A small REST client for Compute Engine v1 and Secret Manager (spec M10), scoped to one project. Its token comes
// from the metadata server on Cloud Run and from `gcloud auth print-access-token` on the Mac; it is never logged.
// Mutations wait for their operation and throw a GceError carrying the operation's error codes, so callers branch on
// `codes` (ZONE_RESOURCE_POOL_EXHAUSTED, QUOTA_EXCEEDED, quotaExceeded, …). Every call times out after 30 s.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const COMPUTE = 'https://compute.googleapis.com/compute/v1';
const SECRETS = 'https://secretmanager.googleapis.com/v1';
const TIMEOUT_MS = 30_000;
const OP_TIMEOUT_MS = 10 * 60_000;

export class GceError extends Error {
  constructor(status, message, codes = []) {
    super(message);
    this.status = status;
    this.codes = codes;
  }
}

export function createGce({ project, token, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  const base = `${COMPUTE}/projects/${project}`;

  async function request(method, url, body) {
    const res = await fetchImpl(url.startsWith('https://') ? url : base + url, {
      method,
      headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      // a body that is not JSON adds nothing
    }
    if (!res.ok) {
      const codes = (json.error?.errors ?? []).map((e) => e.reason).filter(Boolean);
      throw new GceError(res.status, `gce ${method} ${url.replace(/\?.*/, '')}: ${res.status} ${json.error?.message ?? ''}`.trim(), codes);
    }
    return json;
  }

  const absent = (err) => err instanceof GceError && err.status === 404;
  const orNull = (p) => p.catch((err) => (absent(err) ? null : Promise.reject(err)));

  // Waits for an operation (zonal or global, by its selfLink) and throws its error, if any.
  async function settle(op) {
    const start = now();
    while (op.status !== 'DONE') {
      if (now() - start > OP_TIMEOUT_MS) throw new GceError(0, `gce operation ${op.name} did not finish in ${OP_TIMEOUT_MS / 60_000} min`);
      op = await request('POST', `${op.selfLink}/wait`);
      if (op.status !== 'DONE') await sleep(2000);
    }
    if (op.error?.errors?.length) {
      const codes = op.error.errors.map((e) => e.code);
      throw new GceError(op.httpErrorStatusCode ?? 200, `gce operation ${op.name}: ${op.error.errors.map((e) => `${e.code} ${e.message ?? ''}`.trim()).join('; ')}`, codes);
    }
    return op;
  }

  async function* pages(path) {
    let pageToken = '';
    do {
      const body = await request('GET', `${path}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
      yield body;
      pageToken = body.nextPageToken ?? '';
    } while (pageToken);
  }

  const q = (filter) => `filter=${encodeURIComponent(filter)}`;

  return {
    // Every instance in the project matching the filter, across zones.
    instances: async (filter) => {
      const out = [];
      for await (const page of pages(`/aggregated/instances?${q(filter)}&returnPartialSuccess=true`)) {
        for (const scope of Object.values(page.items ?? {})) out.push(...(scope.instances ?? []));
      }
      return out;
    },
    instance: (zone, name) => orNull(request('GET', `/zones/${zone}/instances/${name}`)),
    insertInstance: async (zone, body) => settle(await request('POST', `/zones/${zone}/instances`, body)),
    deleteInstance: async (zone, name) => {
      const op = await orNull(request('DELETE', `/zones/${zone}/instances/${name}`));
      if (op) await orNull(settle(op));
    },
    // The value at a guest attribute path (namespace/key), or null while the guest has not written it.
    guestAttribute: async (zone, name, path) => {
      try {
        const body = await request('GET', `/zones/${zone}/instances/${name}/getGuestAttributes?queryPath=${encodeURIComponent(path)}`);
        return body.queryValue?.items?.[0]?.value ?? null;
      } catch (err) {
        if (absent(err) && /getGuestAttributes/.test(err.message) && (await orNull(request('GET', `/zones/${zone}/instances/${name}`)))) return null;
        throw err;
      }
    },
    images: async (filter) => {
      const out = [];
      for await (const page of pages(`/global/images?${q(filter)}`)) out.push(...(page.items ?? []));
      return out;
    },
    image: (name) => orNull(request('GET', `/global/images/${name}`)),
    insertImage: async (body) => settle(await request('POST', '/global/images', body)),
    setImageLabels: async (name, labels) => {
      const { labelFingerprint } = await request('GET', `/global/images/${name}`);
      return settle(await request('POST', `/global/images/${name}/setLabels`, { labels, labelFingerprint }));
    },
    deleteImage: async (name) => {
      const op = await orNull(request('DELETE', `/global/images/${name}`));
      if (op) await orNull(settle(op));
    },
    secret: async (name) => {
      const body = await request('GET', `${SECRETS}/projects/${project}/secrets/${name}/versions/latest:access`);
      return Buffer.from(body.payload.data, 'base64').toString('utf8');
    },
  };
}

// An async function yielding a valid access token: the attached service account's on Cloud Run (a job sets
// CLOUD_RUN_JOB, a service K_SERVICE), gcloud's default account elsewhere. Tokens are cached for 30 min; both sources
// issue them for an hour.
export function accessToken({ env = process.env, fetchImpl = fetch, exec = gcloudToken, now = Date.now } = {}) {
  let cached = null;
  const onCloudRun = Boolean(env.CLOUD_RUN_JOB || env.K_SERVICE);
  return async () => {
    if (cached && now() - cached.at < 30 * 60_000) return cached.token;
    let token;
    if (onCloudRun) {
      const res = await fetchImpl('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
        headers: { 'metadata-flavor': 'Google' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`ci-kit: the metadata server refused a token (HTTP ${res.status})`);
      token = JSON.parse(await res.text()).access_token;
    } else {
      token = (await exec()).trim();
    }
    if (!token) throw new Error('ci-kit: no Google access token');
    cached = { token, at: now() };
    return token;
  };
}

async function gcloudToken() {
  const { stdout } = await promisify(execFile)('gcloud', ['auth', 'print-access-token'], { timeout: TIMEOUT_MS });
  return stdout;
}
