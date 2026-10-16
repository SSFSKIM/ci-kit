// The guard as the mini runs it: credentials from 0600 files, and the Hetzner half alone when the App's are absent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCredentials, runHetznerOnly } from '../host/guard.mjs';

let dir;
const put = (name, body, mode = 0o600) => {
  writeFileSync(join(dir, name), body);
  chmodSync(join(dir, name), mode);
};
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'ci-kit-guard-'));
});
after(() => rmSync(dir, { recursive: true, force: true }));

test('the Hetzner token alone gives the Hetzner half; the App id and key together give the whole guard', async () => {
  rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), 'ci-kit-guard-'));
  put('hcloud_token', 'tok\n');
  assert.deepEqual(await loadCredentials(dir), { hcloudToken: 'tok', app: null });
  put('app_id', '12345\n');
  put('app.pem', '-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----\n');
  const creds = await loadCredentials(dir);
  assert.equal(creds.app.appId, '12345');
  assert.match(creds.app.pem, /^-----BEGIN RSA PRIVATE KEY-----\n/);
});

test('a credential file others can read, a missing token, or half of the App is refused, naming the file', async () => {
  put('hcloud_token', 'tok\n', 0o644);
  await assert.rejects(loadCredentials(dir), /hcloud_token is readable by others \(mode 644\); chmod 600 it/);
  put('hcloud_token', 'tok\n');
  put('app.pem', 'k', 0o640);
  await assert.rejects(loadCredentials(dir), /app\.pem is readable by others/);
  rmSync(join(dir, 'app.pem'));
  await assert.rejects(loadCredentials(dir), /app_id without app\.pem/);
  rmSync(join(dir, 'app_id'));
  rmSync(join(dir, 'hcloud_token'));
  await assert.rejects(loadCredentials(dir), /no Hetzner token at .*hcloud_token/);
});

// A Hetzner project as the guard sees it: labelled servers, deletes recorded, every action finished at once.
function hetzner(servers) {
  const deleted = [];
  return {
    deleted,
    hc: {
      servers: async () => servers,
      deleteServer: async (id) => {
        deleted.push(id);
        return { id: 1000 + id };
      },
      action: async (id) => ({ id, status: 'success' }),
    },
  };
}

test('without GitHub, the guard still deletes a dead or over-age pool box and an old builder, and nothing else', async () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  const ago = (min) => new Date(now - min * 60_000).toISOString();
  const beat = (min) => String(Math.floor((now - min * 60_000) / 1000));
  const { hc, deleted } = hetzner([
    { id: 1, created: ago(60), labels: { 'ci-kit': 'pool', 'ci-kit-heartbeat': beat(30) } }, // stale heartbeat
    { id: 2, created: ago(25 * 60), labels: { 'ci-kit': 'pool', 'ci-kit-heartbeat': beat(1) } }, // over 24 h
    { id: 3, created: ago(60), labels: { 'ci-kit': 'pool', 'ci-kit-heartbeat': beat(1) } }, // healthy
    { id: 4, created: ago(3 * 60), labels: { 'ci-kit': 'builder', 'ci-kit-run': '9' } }, // builder past 2 h
    { id: 5, created: ago(30), labels: { 'ci-kit': 'builder' } }, // young builder
    { id: 6, created: ago(48 * 60), labels: {} }, // not the kit's
  ]);
  const lines = [];
  const failed = await runHetznerOnly({ hc, cfg: { max_hours_per_day: 8 }, now: () => now, sleep: async () => {}, log: (l) => lines.push(l) });
  assert.equal(failed, 0);
  assert.deepEqual(deleted, [1, 2, 4]);
  assert.match(lines.join('\n'), /no GitHub credentials: deleted pool server 1 \(stale-heartbeat\) with no ledger row/);
  assert.match(lines.join('\n'), /deleted builder 4/);
});

test('with nothing to do, a Hetzner-only cycle deletes nothing and says so', async () => {
  const { hc, deleted } = hetzner([]);
  const lines = [];
  assert.equal(await runHetznerOnly({ hc, cfg: { max_hours_per_day: 8 }, now: Date.now, sleep: async () => {}, log: (l) => lines.push(l) }), 0);
  assert.deepEqual(deleted, []);
  assert.match(lines.join('\n'), /guard \(Hetzner only\): 0 labelled servers; 0 actions/);
});

test('a failed delete is counted and the others still run', async () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  const old = new Date(now - 3 * 3600_000).toISOString();
  const { hc, deleted } = hetzner([
    { id: 7, created: old, labels: { 'ci-kit': 'builder' } },
    { id: 8, created: old, labels: { 'ci-kit': 'builder' } },
  ]);
  const realDelete = hc.deleteServer;
  hc.deleteServer = async (id) => {
    if (id === 7) throw new Error('hcloud DELETE /servers/7: HTTP 500');
    return realDelete(id);
  };
  const errors = [];
  const failed = await runHetznerOnly({ hc, cfg: { max_hours_per_day: 8 }, now: () => now, sleep: async () => {}, log: () => {}, error: (e) => errors.push(e) });
  assert.equal(failed, 1);
  assert.deepEqual(deleted, [8]);
  assert.match(errors[0], /delete-builder failed: hcloud DELETE \/servers\/7/);
});
