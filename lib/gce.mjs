// A small REST client for Compute Engine v1 and Secret Manager (spec M10), scoped to one project. Its token comes
// from the metadata server on Cloud Run and from `gcloud auth print-access-token` on the Mac; it is never logged.
// Mutations wait for their operation and throw a GceError carrying the operation's error codes, so callers branch on
// `codes` (ZONE_RESOURCE_POOL_EXHAUSTED, QUOTA_EXCEEDED, quotaExceeded, …). Every call times out after 30 s, except an operation's wait, which blocks for up to 2 min by design.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const COMPUTE = 'https://compute.googleapis.com/compute/v1';
const SECRETS = 'https://secretmanager.googleapis.com/v1';
const MONITORING = 'https://monitoring.googleapis.com/v3';
const TIMEOUT_MS = 30_000;
const OP_TIMEOUT_MS = 30 * 60_000; // an image of a 30 GB disk takes minutes
const WAIT_CALL_MS = 150_000;
const INCOMPLETE = new Set(['UNREACHABLE', 'PARTIAL_SUCCESS', 'LIST_OVERHEAD_QUOTA_EXCEED']);

// `accepted` is true when the request that failed had already been accepted: the error came from its operation's
// wait call or from the finished operation. A caller must then assume the resource may exist. `finished` is true only
// when the operation itself completed with this error, so its outcome is definite; `operation` is its link.
export class GceError extends Error {
  constructor(status, message, codes = [], { accepted = false, finished = false, operation = null } = {}) {
    super(message);
    this.status = status;
    this.codes = codes;
    this.accepted = accepted;
    this.finished = finished;
    this.operation = operation;
  }
}

export function createGce({ project, token, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now }) {
  const base = `${COMPUTE}/projects/${project}`;

  async function request(method, url, body, { timeoutMs = TIMEOUT_MS } = {}) {
    const res = await fetchImpl(url.startsWith('https://') ? url : base + url, {
      method,
      headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
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

  // Waits for an operation (zonal or global, by its selfLink) and throws its error, if any. Every error from here on
  // is marked accepted: the request that started the operation was taken, whatever status the failure carries.
  // A deadline (ms) shorter than the default bounds the wait: past it, the error is accepted but not finished.
  async function settle(op, { deadlineMs = OP_TIMEOUT_MS } = {}) {
    try {
      return await settleAccepted(op, deadlineMs);
    } catch (err) {
      if (err instanceof GceError) {
        err.accepted = true;
        err.operation ??= op.selfLink ?? null;
      }
      throw err;
    }
  }

  async function settleAccepted(op, deadlineMs) {
    const start = now();
    while (op.status !== 'DONE') {
      if (now() - start >= deadlineMs) throw new GceError(0, `gce operation ${op.name} did not finish in ${Math.round(deadlineMs / 1000)} s`, [], { operation: op.selfLink });
      // The wait call itself blocks until the operation is done or about 2 minutes have passed.
      const timeoutMs = Math.min(WAIT_CALL_MS, Math.max(1000, deadlineMs - (now() - start)));
      op = await request('POST', `${op.selfLink}/wait`, undefined, { timeoutMs });
      if (op.status !== 'DONE' && now() - start < deadlineMs) await sleep(2000);
    }
    if (op.error?.errors?.length) {
      const codes = op.error.errors.map((e) => e.code);
      throw new GceError(op.httpErrorStatusCode ?? 200, `gce operation ${op.name}: ${op.error.errors.map((e) => `${e.code} ${e.message ?? ''}`.trim()).join('; ')}`, codes, { finished: true, operation: op.selfLink });
    }
    return op;
  }

  // A delete of something already gone is done. Unless asked to wait, it returns once the request is accepted: the
  // launcher confirms the resource gone on its next tick rather than spending its budget here.
  async function remove(path, { wait = true } = {}) {
    const op = await orNull(request('DELETE', path));
    if (op && wait) await orNull(settle(op));
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

  // Every resource of a kind matching the filter, across zones: {items, complete, zones}. With returnPartialSuccess a
  // zone the API cannot reach is reported (`unreachables`, or an UNREACHABLE, PARTIAL_SUCCESS or LIST_OVERHEAD_QUOTA_EXCEED
  // warning on the page or a zone's scope) instead of failing the call; the listing is then not complete, and a
  // caller must not read a resource's absence from it. NO_RESULTS_ON_PAGE only says a zone has none. `zones`: the
  // zones read whole: every zone of the project has a scope, an empty one too, so a zone missing from it, or flagged
  // on any page, may hide resources. A warning on a whole page names no zone, and leaves none vouched for.
  async function aggregated(kind, filter) {
    const items = [];
    let complete = true;
    let whole = true;
    const seen = new Set();
    const flagged = new Set();
    const zone = (scope) => /^zones\/(.+)$/.exec(scope)?.[1];
    for await (const page of pages(`/aggregated/${kind}?${q(filter)}&returnPartialSuccess=true`)) {
      if (page.unreachables?.length) complete = false;
      for (const scope of page.unreachables ?? []) flagged.add(zone(scope.split('/').slice(-2).join('/')) ?? scope);
      if (INCOMPLETE.has(page.warning?.code)) complete = whole = false;
      for (const [name, scope] of Object.entries(page.items ?? {})) {
        if (zone(name)) seen.add(zone(name));
        if (INCOMPLETE.has(scope.warning?.code)) {
          complete = false;
          flagged.add(zone(name) ?? name);
        }
        items.push(...(scope[kind] ?? []));
      }
    }
    return { items, complete, zones: whole ? new Set([...seen].filter((z) => !flagged.has(z))) : new Set() };
  }

  return {
    instances: async (filter) => (await aggregated('instances', filter)).items,
    listInstances: (filter) => aggregated('instances', filter),
    instance: (zone, name) => orNull(request('GET', `/zones/${zone}/instances/${name}`)),
    insertInstance: async (zone, body, { deadlineMs } = {}) => settle(await request('POST', `/zones/${zone}/instances`, body), { deadlineMs }),
    deleteInstance: (zone, name, opts) => remove(`/zones/${zone}/instances/${name}`, opts),
    listDisks: (filter) => aggregated('disks', filter),
    deleteDisk: (zone, name, opts) => remove(`/zones/${zone}/disks/${name}`, opts),
    operations: async (filter) => {
      const { items, complete } = await aggregated('operations', filter);
      if (!complete) throw new GceError(0, 'gce operations: the listing is incomplete (some zones unreachable or partial)');
      return items;
    },
    zoneOperations: async (zone, filter) => {
      const out = [];
      for await (const page of pages(`/zones/${zone}/operations?${q(filter)}`)) out.push(...(page.items ?? []));
      return out;
    },
    operation: (selfLink) => orNull(request('GET', selfLink)),
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
    deleteImage: (name, opts) => remove(`/global/images/${name}`, opts),
    // Cloud Monitoring's time series matching `filter` over [start, end) (RFC 3339), with `aggregation` as the API's
    // aggregation.* parameters ({alignmentPeriod, perSeriesAligner, crossSeriesReducer, groupByFields}), every page.
    timeSeries: async (filter, { start, end, aggregation = {} }) => {
      const params = new URLSearchParams({
        filter, 'interval.startTime': start, 'interval.endTime': end, ...Object.fromEntries(Object.entries(aggregation).map(([k, v]) => [`aggregation.${k}`, v])),
      });
      const out = [];
      for await (const page of pages(`${MONITORING}/projects/${project}/timeSeries?${params}`)) {
        // A page that could not read all its data says so beside what it read: a partial total is no total.
        if (page.executionErrors?.length || page.unreachable?.length) {
          throw new GceError(0, `monitoring timeSeries: the read is incomplete (${JSON.stringify(page.executionErrors ?? page.unreachable).slice(0, 200)})`);
        }
        out.push(...(page.timeSeries ?? []));
      }
      return out;
    },
    secret: async (name) => {
      const body = await request('GET', `${SECRETS}/projects/${project}/secrets/${name}/versions/latest:access`);
      return Buffer.from(body.payload.data, 'base64').toString('utf8');
    },
  };
}

// An async function yielding a valid access token: the attached service account's on Cloud Run (a job sets
// CLOUD_RUN_JOB, a service K_SERVICE), gcloud's default account elsewhere. A token is kept until TOKEN_MARGIN_MS
// before its own expiry, as its source reports it: either source may hand back a cached token with minutes left (a
// bake from the Mac held gcloud's for a fixed 30 min and died on a 401, pool M3).
const TOKEN_MARGIN_MS = 5 * 60_000;
export function accessToken({ env = process.env, fetchImpl = fetch, exec = gcloudToken, now = Date.now } = {}) {
  let cached = null;
  const onCloudRun = Boolean(env.CLOUD_RUN_JOB || env.K_SERVICE);
  return async () => {
    if (cached && now() < cached.until) return cached.token;
    let token;
    let expires;
    if (onCloudRun) {
      const asked = now();
      const res = await fetchImpl('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
        headers: { 'metadata-flavor': 'Google' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`ci-kit: the metadata server refused a token (HTTP ${res.status})`);
      const body = JSON.parse(await res.text());
      token = body.access_token;
      expires = asked + body.expires_in * 1000;
    } else {
      const { credential } = JSON.parse(await exec());
      token = credential?.access_token;
      expires = Date.parse(credential?.token_expiry);
    }
    if (!token) throw new Error('ci-kit: no Google access token');
    // A token whose expiry is unreadable is used for this call only.
    cached = { token, until: Number.isFinite(expires) ? expires - TOKEN_MARGIN_MS : 0 };
    return token;
  };
}

// gcloud's token with its expiry, at least 15 min from expiring (config-helper refreshes it when it has less).
async function gcloudToken() {
  const { stdout } = await promisify(execFile)('gcloud', ['config', 'config-helper', '--min-expiry=15m', '--format=json'], { timeout: TIMEOUT_MS });
  return stdout;
}
