// A small Hetzner Cloud API v1 client. Every call times out after 20 s. Errors carry Hetzner's error code
// (`uniqueness_error`, `resource_unavailable`, …) so callers can branch on it.
// The token is never logged; neither is a server-create response, which carries a root password.
const API = 'https://api.hetzner.cloud/v1';
const TIMEOUT_MS = 20_000;

export class HcloudError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function createHcloud(token, { fetchImpl = fetch, api = API } = {}) {
  if (!token) throw new Error('ci-kit: no Hetzner token');

  async function request(method, path, body) {
    const res = await fetchImpl(api + path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
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
      const code = json.error?.code ?? `http_${res.status}`;
      throw new HcloudError(res.status, code, `hcloud ${method} ${path}: ${res.status} ${code}${json.error?.message ? ` (${json.error.message})` : ''}`);
    }
    return json;
  }

  async function list(path, key) {
    const items = [];
    for (let page = 1; ; page += 1) {
      const sep = path.includes('?') ? '&' : '?';
      const body = await request('GET', `${path}${sep}per_page=50&page=${page}`);
      items.push(...(body[key] ?? []));
      if (!body.meta?.pagination?.next_page) return items;
    }
  }

  const selector = (labelSelector) => `?label_selector=${encodeURIComponent(labelSelector)}`;

  return {
    request,
    servers: (labelSelector) => list(`/servers${selector(labelSelector)}`, 'servers'),
    server: async (id) => (await request('GET', `/servers/${id}`)).server,
    createServer: async (spec) => {
      const { server, action } = await request('POST', '/servers', spec);
      return { server: { id: server.id, name: server.name, created: server.created, labels: server.labels }, action };
    },
    deleteServer: async (id) => (await request('DELETE', `/servers/${id}`)).action,
    setLabels: async (id, labels) => (await request('PUT', `/servers/${id}`, { labels })).server,
    images: (labelSelector) => list(`/images${selector(labelSelector)}&type=snapshot`, 'images'),
    image: async (id) => (await request('GET', `/images/${id}`)).image,
    deleteImage: (id) => request('DELETE', `/images/${id}`),
    createImage: (serverId, spec) => request('POST', `/servers/${serverId}/actions/create_image`, spec),
    firewalls: (labelSelector) => list(`/firewalls${selector(labelSelector)}`, 'firewalls'),
    createFirewall: async (spec) => (await request('POST', '/firewalls', spec)).firewall,
    serverTypes: () => list('/server_types', 'server_types'),
    action: async (id) => (await request('GET', `/actions/${id}`)).action,
  };
}

// The token, from the environment (workflows) or a file (the box's /etc/ci-kit/hcloud_token).
export async function hcloudFromEnv({ env = process.env, readFile } = {}) {
  if (env.HCLOUD_TOKEN) return createHcloud(env.HCLOUD_TOKEN.trim());
  if (env.HCLOUD_TOKEN_FILE && readFile) return createHcloud((await readFile(env.HCLOUD_TOKEN_FILE, 'utf8')).trim());
  throw new Error('ci-kit: HCLOUD_TOKEN is not set');
}

// Wait for a Hetzner action to finish. Returns the action; throws on an action error or after `timeoutMs`.
export async function waitAction(hc, actionId, { timeoutMs = 120_000, sleep, now = Date.now, interval = 3000 }) {
  const start = now();
  for (;;) {
    const action = await hc.action(actionId);
    if (action.status === 'success') return action;
    if (action.status === 'error') throw new Error(`hcloud action ${actionId} failed: ${action.error?.code ?? 'error'}`);
    if (now() - start > timeoutMs) throw new Error(`hcloud action ${actionId} did not finish in ${Math.round(timeoutMs / 1000)} s`);
    await sleep(interval);
  }
}

// Only resources the kit made: the label is checked again on the client, whatever the API's selector did.
export const hasKitLabel = (resource, value) =>
  resource?.labels?.['ci-kit'] !== undefined && (value === undefined || resource.labels['ci-kit'] === value);

export const serverLocation = (server) => server.location?.name ?? server.datacenter?.location?.name ?? null;

export function serverPriceHourly(server) {
  const loc = serverLocation(server);
  const price = server.server_type?.prices?.find((p) => p.location === loc);
  return price ? Number(price.price_hourly.gross) : null;
}
