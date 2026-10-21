// The webhook receiver ci-kit-webhook (spec 2026-10-21 M4): a delivery is verified against the secret before anything
// else is read, and a pool job queued in a served repo publishes one tick request; nothing else does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { signatureValid, tickRequest, createReceiver, createPublisher, MAX_BODY, SECRET_TTL_MS, REREAD_AFTER_MS } from '../../gce/webhook/receiver.mjs';

const SECRET = 'a3f1c9e0b7d24e6f8a1b3c5d7e9f0a2b';
const sign = (body, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const MACHINES = { 2: 'c4d-highcpu-2', 4: 'c4d-highcpu-4', 8: 'c4d-highcpu-8', 16: 'c4d-highcpu-16' };
const SERVED = new Set(['ssfskim/maws']);

const queued = (over = {}) => ({
  action: 'queued',
  repository: { full_name: 'SSFSKIM/MAWS' },
  workflow_job: { id: 119166794835, run_id: 18800000001, labels: ['self-hosted', 'ci-kit-pool', 'cpus-4'], ...over },
});

test('a signature is valid only for this body under this secret, in the sha256= form', () => {
  const body = Buffer.from('{"zen":"Keep it logically awesome."}');
  assert.equal(signatureValid(SECRET, body, sign(body)), true);
  assert.equal(signatureValid(SECRET, body, sign(body, 'another secret')), false);
  assert.equal(signatureValid(SECRET, Buffer.from('{"zen":"tampered"}'), sign(body)), false);
  assert.equal(signatureValid(SECRET, body, sign(body).replace('sha256=', 'sha1=')), false);
  assert.equal(signatureValid(SECRET, body, sign(body).slice(0, -2)), false);
  assert.equal(signatureValid(SECRET, body, undefined), false);
  assert.equal(signatureValid('', body, sign(body, '')), false); // no secret, no delivery is genuine
});

test('a queued pool job of a served repo requests a tick, naming its job', () => {
  assert.deepEqual(tickRequest({ event: 'workflow_job', payload: queued(), served: SERVED, machines: MACHINES }), {
    request: { repo: 'SSFSKIM/MAWS', job: 119166794835, run: 18800000001, labels: ['self-hosted', 'ci-kit-pool', 'cpus-4'] },
  });
});

test('nothing else requests a tick', () => {
  const ignored = (event, payload) => tickRequest({ event, payload, served: SERVED, machines: MACHINES }).ignored;
  assert.match(ignored('ping', { zen: 'x' }), /ping/);
  assert.match(ignored('push', queued()), /event push/);
  for (const action of ['in_progress', 'completed', 'waiting']) assert.match(ignored('workflow_job', { ...queued(), action }), new RegExp(action));
  assert.match(ignored('workflow_job', { ...queued(), repository: { full_name: 'SSFSKIM/ci-kit' } }), /not served/);
  assert.match(ignored('workflow_job', queued({ labels: ['ubuntu-slim'] })), /labels/); // MAWS's plan job, until M5
  assert.match(ignored('workflow_job', queued({ labels: ['self-hosted', 'ci-kit-pool', 'cpus-32'] })), /labels/);
  assert.match(ignored('workflow_job', queued({ labels: ['self-hosted', 'ci-kit-pool', 'cpus-4', 'gpu'] })), /labels/);
  assert.match(ignored('workflow_job', { action: 'queued' }), /labels|not served/);
});

// The receiver as Cloud Run runs it, on a local port: what it answers and what it publishes.
async function receiver({ secret = async () => SECRET, publish, now } = {}) {
  const published = [];
  const logs = [];
  const handler = createReceiver({
    secret,
    now,
    publish: publish ?? (async (m) => { published.push(m); }),
    served: SERVED,
    machines: MACHINES,
    log: (severity, message, extra) => logs.push({ severity, message, ...extra }),
  });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const post = async (payload, { event = 'workflow_job', signature, method = 'POST', raw } = {}) => {
    const body = raw ?? Buffer.from(JSON.stringify(payload));
    const headers = { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': 'd-1' };
    const sig = signature === undefined ? sign(body) : signature;
    if (sig !== null) headers['x-hub-signature-256'] = sig;
    const res = await fetch(url, { method, headers, body: method === 'GET' ? undefined : body });
    return { status: res.status, body: await res.text() };
  };
  return { post, published, logs, close: () => new Promise((r) => server.close(r)) };
}

test('a signed queued pool job publishes one tick request with its delivery, and is answered 202', async (t) => {
  const r = await receiver();
  t.after(r.close);
  const res = await r.post(queued());
  assert.equal(res.status, 202);
  assert.deepEqual(r.published, [{ repo: 'SSFSKIM/MAWS', job: 119166794835, run: 18800000001, labels: ['self-hosted', 'ci-kit-pool', 'cpus-4'], delivery: 'd-1' }]);
});

test('a forged, missing or stale signature gets 401 and publishes nothing', async (t) => {
  const r = await receiver();
  t.after(r.close);
  const body = Buffer.from(JSON.stringify(queued()));
  for (const signature of [sign(body, 'the old secret'), null, 'sha256=00', 'garbage']) {
    const res = await r.post(null, { raw: body, signature });
    assert.equal(res.status, 401, String(signature));
  }
  assert.deepEqual(r.published, []);
});

test('the signature is checked before the body is parsed: a forged body that is not JSON is still 401', async (t) => {
  const r = await receiver();
  t.after(r.close);
  assert.equal((await r.post(null, { raw: Buffer.from('not json'), signature: 'sha256=' + '0'.repeat(64) })).status, 401);
  assert.equal((await r.post(null, { raw: Buffer.from('not json') })).status, 400);
});

test('an ignored delivery is answered 200 with its reason; a ping too', async (t) => {
  const r = await receiver();
  t.after(r.close);
  const res = await r.post({ ...queued(), action: 'completed' });
  assert.equal(res.status, 200);
  assert.match(res.body, /completed/);
  assert.equal((await r.post({ zen: 'x', hook_id: 1 }, { event: 'ping' })).status, 200);
  assert.deepEqual(r.published, []);
});

test('only POST is served, and a body over the cap is refused before its signature is computed', async (t) => {
  const r = await receiver();
  t.after(r.close);
  assert.equal((await r.post(null, { method: 'GET' })).status, 405);
  const big = Buffer.alloc(MAX_BODY + 1, 0x20);
  assert.equal((await r.post(null, { raw: big })).status, 413);
  assert.deepEqual(r.published, []);
});

test('an unreadable secret answers 500 and a failed publish 502, and both are logged', async (t) => {
  const broken = await receiver({ secret: async () => { throw new Error('permission denied on secret'); } });
  t.after(broken.close);
  assert.equal((await broken.post(queued())).status, 500);
  assert.match(broken.logs[0].message, /secret/);
  const down = await receiver({ publish: async () => { throw new Error('pubsub 503'); } });
  t.after(down.close);
  assert.equal((await down.post(queued())).status, 502);
  assert.match(down.logs.at(-1).message, /pubsub 503/);
});

test('the publisher posts the request as one Pub/Sub message, base64 JSON, with the service account token', async () => {
  const calls = [];
  const publish = createPublisher({
    topic: 'projects/ssfskim-ci-kit/topics/ci-kit-tick-requests',
    token: async () => 'tok',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ messageIds: ['1'] }), { status: 200 });
    },
  });
  await publish({ repo: 'SSFSKIM/MAWS', job: 1 });
  assert.equal(calls[0].url, 'https://pubsub.googleapis.com/v1/projects/ssfskim-ci-kit/topics/ci-kit-tick-requests:publish');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok');
  const { messages } = JSON.parse(calls[0].init.body);
  assert.deepEqual(JSON.parse(Buffer.from(messages[0].data, 'base64').toString()), { repo: 'SSFSKIM/MAWS', job: 1 });
});

test('a refused publish throws with its status', async () => {
  const publish = createPublisher({
    topic: 'projects/p/topics/t',
    token: async () => 'tok',
    fetchImpl: async () => new Response('{"error":{"message":"denied"}}', { status: 403 }),
  });
  await assert.rejects(publish({}), /403/);
});

// The secret is a Cloud Run volume that Secret Manager serves on every read, a paid and quota-bound access each.
function countedSecret(initial) {
  const store = { value: initial, reads: 0 };
  store.read = async () => {
    store.reads += 1;
    return store.value;
  };
  return store;
}

test('a delivery with no signature, or one not shaped sha256=<64 hex>, is refused without reading the secret', async (t) => {
  const key = countedSecret(SECRET);
  const r = await receiver({ secret: key.read });
  t.after(r.close);
  const body = Buffer.from(JSON.stringify(queued()));
  for (const signature of [null, '', 'garbage', 'sha256=00', `sha1=${'0'.repeat(40)}`, `sha256=${'G'.repeat(64)}`, `sha256=${'0'.repeat(65)}`]) {
    assert.equal((await r.post(null, { raw: body, signature })).status, 401, String(signature));
  }
  assert.equal(key.reads, 0);
});

test('forged but well-formed signatures read the secret once per TTL, not once each', async (t) => {
  let clock = 1_000_000;
  const key = countedSecret(SECRET);
  const r = await receiver({ secret: key.read, now: () => clock });
  t.after(r.close);
  const body = Buffer.from(JSON.stringify(queued()));
  for (let i = 0; i < 20; i += 1) {
    assert.equal((await r.post(null, { raw: body, signature: sign(body, `forged ${i}`) })).status, 401);
    clock += 2_000; // 40 s in all: inside the TTL, and past the re-read floor more than once
  }
  assert.ok(key.reads <= 1 + Math.ceil(40_000 / REREAD_AFTER_MS), `${key.reads} reads`);
  await r.post(null, { raw: body, signature: sign(body, 'forged') }); // the copy is 10 s old: one re-read
  const flood = key.reads;
  for (let i = 0; i < 20; i += 1) await r.post(null, { raw: body, signature: sign(body, 'forged') }); // no time passes
  assert.equal(key.reads, flood);
  assert.equal((await r.post(queued())).status, 202); // the genuine secret still verifies from the cache
  assert.equal(key.reads, flood);
});

test('a rotated secret is used once the TTL has passed, with no deploy', async (t) => {
  let clock = 1_000_000;
  const key = countedSecret(SECRET);
  const r = await receiver({ secret: key.read, now: () => clock });
  t.after(r.close);
  assert.equal((await r.post(queued())).status, 202);
  key.value = 'the rotated secret';
  clock += SECRET_TTL_MS;
  const body = Buffer.from(JSON.stringify(queued()));
  assert.equal((await r.post(null, { raw: body, signature: sign(body, 'the rotated secret') })).status, 202);
  assert.equal((await r.post(null, { raw: body })).status, 401); // the old secret no longer verifies
});

test('a mismatch re-reads the secret once the cache is older than the re-read floor, so a rotation is live at once', async (t) => {
  let clock = 1_000_000;
  const key = countedSecret(SECRET);
  const r = await receiver({ secret: key.read, now: () => clock });
  t.after(r.close);
  assert.equal((await r.post(queued())).status, 202);
  assert.equal(key.reads, 1);
  key.value = 'the rotated secret';
  const body = Buffer.from(JSON.stringify(queued()));
  const rotated = sign(body, 'the rotated secret');
  assert.equal((await r.post(null, { raw: body, signature: rotated })).status, 401); // the cache is fresh: no re-read
  assert.equal(key.reads, 1);
  clock += REREAD_AFTER_MS;
  assert.equal((await r.post(null, { raw: body, signature: rotated })).status, 202);
  assert.equal(key.reads, 2);
});
