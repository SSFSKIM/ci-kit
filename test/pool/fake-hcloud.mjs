// A fake Hetzner client over recorded resource shapes. Like a careless API, it ignores label selectors and returns
// every resource in the project, so the code under test must check labels itself (the project holds other work's
// resources: firewall ks2-db-fw and server session-mirror, both unlabelled, seen 2026-10-15).
// FOREIGN is the shared foreign fixture: resources the kit must never delete, label or use, some of them matching
// the kit's names. `strict: true` makes names unique, as Hetzner does, so a foreign resource holding a kit name
// makes the kit's create fail the way the real API would. foreignTouched(hc) lists every mutation that reached a
// foreign resource.
import { HcloudError } from '../../lib/hcloud.mjs';

export const FOREIGN = {
  servers: [
    { id: 170646065, name: 'session-mirror', labels: {}, created: '2026-09-01T00:00:00Z', status: 'running' },
    { id: 170646066, name: 'ci-kit-pool', labels: {}, created: '2026-09-01T00:00:00Z', status: 'running' },
    { id: 170646067, name: 'ci-kit-builder-1', labels: { owner: 'someone' }, created: '2026-09-01T00:00:00Z', status: 'off' },
  ],
  firewalls: [
    { id: 11774146, name: 'ks2-db-fw', labels: {} },
    { id: 11774147, name: 'ci-kit-pool-old', labels: {} },
    { id: 11774148, name: 'ci-kit-pool', labels: {} },
  ],
  images: [
    { id: 900, type: 'snapshot', status: 'available', labels: {}, created: '2026-10-15T23:00:00Z', description: 'not ours' },
    { id: 901, type: 'snapshot', status: 'creating', labels: { 'ci-kit-run': '42' }, created: '2026-10-15T23:00:00Z', description: 'not ours, carries a run id' },
  ],
};
const FOREIGN_IDS = {
  servers: new Set(FOREIGN.servers.map((x) => x.id)),
  firewalls: new Set(FOREIGN.firewalls.map((x) => x.id)),
  images: new Set(FOREIGN.images.map((x) => x.id)),
};

// Every mutation that touched a foreign resource: deleted, labelled, snapshotted, or used by a created server.
export function foreignTouched(hc) {
  return hc.mutations.filter((m) =>
    (m.server !== undefined && FOREIGN_IDS.servers.has(m.server)) ||
    (m.image !== undefined && FOREIGN_IDS.images.has(m.image)) ||
    (m.firewalls ?? []).some((f) => FOREIGN_IDS.firewalls.has(f)));
}

export function fakeHcloud({ servers = [], firewalls = [], images = [], serverTypes = [], createErrors = [], serverSeq = null, strict = false } = {}) {
  const calls = [];
  const mutations = [];
  const taken = (list, name) => strict && list.some((x) => x.name === name);
  const unique = () => new HcloudError(409, 'uniqueness_error', 'name is already used');
  const state = {
    servers: [...FOREIGN.servers, ...servers],
    firewalls: [...FOREIGN.firewalls, ...firewalls],
    images: [...FOREIGN.images, ...images],
  };
  let listCount = 0;
  let nextId = 5000;
  const hc = {
    calls,
    mutations,
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
      mutations.push({ op: 'create server', image: spec.image, firewalls: (spec.firewalls ?? []).map((f) => f.firewall) });
      if (taken(state.servers, spec.name)) throw unique();
      const err = createErrors.shift();
      if (err) throw new HcloudError(err === 'uniqueness_error' ? 409 : 412, err, err);
      const server = { id: nextId++, created: '2026-10-15T23:00:00Z', ...spec };
      state.servers.push(server);
      return { server, action: { id: 1 } };
    },
    async deleteServer(id) {
      calls.push(`delete server ${id}`);
      mutations.push({ op: 'delete server', server: id });
      state.servers = state.servers.filter((s) => s.id !== id);
      return { id: 77, status: 'success' };
    },
    async setLabels(id, labels) {
      calls.push(`labels ${id} ${JSON.stringify(labels)}`);
      mutations.push({ op: 'label server', server: id });
      const s = state.servers.find((x) => x.id === id);
      s.labels = labels;
      return s;
    },
    async images(sel) {
      calls.push(`images ${sel}`);
      return state.images;
    },
    async createImage(serverId) {
      calls.push(`snapshot ${serverId}`);
      mutations.push({ op: 'snapshot', server: serverId });
      return { image: { id: 7000 }, action: { id: 2 } };
    },
    async image(id) {
      return { id, status: 'available', image_size: 1.5, disk_size: 40 };
    },
    async deleteImage(id) {
      calls.push(`delete image ${id}`);
      mutations.push({ op: 'delete image', image: id });
      state.images = state.images.filter((i) => i.id !== id);
    },
    async firewalls(sel) {
      calls.push(`firewalls ${sel}`);
      return state.firewalls;
    },
    async createFirewall(spec) {
      calls.push(`create firewall ${spec.name}`);
      mutations.push({ op: 'create firewall' });
      if (taken(state.firewalls, spec.name)) throw unique();
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
