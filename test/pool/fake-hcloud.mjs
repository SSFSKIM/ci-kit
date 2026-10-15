// A fake Hetzner client over recorded resource shapes. Like a careless API, it ignores label selectors and returns
// every resource in the project, so the code under test must check labels itself (the project holds other work's
// resources: firewall ks2-db-fw and server session-mirror, both unlabelled, seen 2026-10-15).
import { HcloudError } from '../../lib/hcloud.mjs';

export const FOREIGN = {
  servers: [
    { id: 170646065, name: 'session-mirror', labels: {}, created: '2026-09-01T00:00:00Z', status: 'running' },
    { id: 170646066, name: 'ci-kit-pool', labels: {}, created: '2026-09-01T00:00:00Z', status: 'running' },
    { id: 170646067, name: 'ci-kit-builder-1', labels: { owner: 'someone' }, created: '2026-09-01T00:00:00Z', status: 'off' },
  ],
  firewalls: [{ id: 11774146, name: 'ks2-db-fw', labels: {} }, { id: 11774147, name: 'ci-kit-pool-old', labels: {} }],
  images: [{ id: 900, type: 'snapshot', status: 'available', labels: {}, created: '2026-10-15T23:00:00Z', description: 'not ours' }],
};

export function fakeHcloud({ servers = [], firewalls = [], images = [], serverTypes = [], createErrors = [], serverSeq = null } = {}) {
  const calls = [];
  const state = {
    servers: [...FOREIGN.servers, ...servers],
    firewalls: [...FOREIGN.firewalls, ...firewalls],
    images: [...FOREIGN.images, ...images],
  };
  let listCount = 0;
  let nextId = 5000;
  const hc = {
    calls,
    state,
    async servers(sel) {
      calls.push(`servers ${sel}`);
      if (serverSeq) return [...FOREIGN.servers, ...serverSeq[Math.min(listCount++, serverSeq.length - 1)]];
      return state.servers;
    },
    async server(id) {
      const s = state.servers.find((x) => x.id === id);
      if (!s) throw new HcloudError(404, 'not_found', `server ${id} not found`);
      return s;
    },
    async createServer(spec) {
      calls.push(`create ${spec.server_type}@${spec.location}`);
      const err = createErrors.shift();
      if (err) throw new HcloudError(err === 'uniqueness_error' ? 409 : 412, err, err);
      const server = { id: nextId++, created: '2026-10-15T23:00:00Z', ...spec };
      state.servers.push(server);
      return { server, action: { id: 1 } };
    },
    async deleteServer(id) {
      calls.push(`delete server ${id}`);
      state.servers = state.servers.filter((s) => s.id !== id);
      return { id: 77, status: 'success' };
    },
    async setLabels(id, labels) {
      calls.push(`labels ${id} ${JSON.stringify(labels)}`);
      const s = state.servers.find((x) => x.id === id);
      s.labels = labels;
      return s;
    },
    async images(sel) {
      calls.push(`images ${sel}`);
      return state.images;
    },
    async deleteImage(id) {
      calls.push(`delete image ${id}`);
      state.images = state.images.filter((i) => i.id !== id);
    },
    async firewalls(sel) {
      calls.push(`firewalls ${sel}`);
      return state.firewalls;
    },
    async createFirewall(spec) {
      calls.push(`create firewall ${spec.name}`);
      const fw = { id: 6000, ...spec };
      state.firewalls.push(fw);
      return fw;
    },
    async serverTypes() {
      return serverTypes;
    },
    async action() {
      return { status: 'success', finished: '2026-10-15T23:00:05Z' };
    },
  };
  return hc;
}

export const deletes = (hc) => hc.calls.filter((c) => c.startsWith('delete'));
