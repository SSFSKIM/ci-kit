// The small Compute Engine / Secret Manager client (lib/gce.mjs) against recorded response shapes: errors carry
// their reasons, mutations wait for their operation and fail with its error codes, 404s read as absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGce, GceError, accessToken } from '../../lib/gce.mjs';

const BASE = 'https://compute.googleapis.com/compute/v1/projects/ssfskim-ci-kit';
const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
// Recorded 2026-10-16: GET of a missing instance.
const NOT_FOUND = { error: { code: 404, message: "The resource 'projects/ssfskim-ci-kit/zones/us-central1-a/instances/nope' was not found", errors: [{ message: 'x', domain: 'global', reason: 'notFound' }] } };

function fake(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const key = `${init.method} ${url.replace(BASE, '')}`;
    calls.push({ key, body: init.body && JSON.parse(init.body), auth: init.headers.authorization });
    for (const [pattern, reply] of routes) if (key.startsWith(pattern)) return typeof reply === 'function' ? reply(key, init) : reply;
    return json(404, NOT_FOUND);
  };
  return { calls, fetchImpl };
}

const gceWith = (routes) => {
  const f = fake(routes);
  return { f, gce: createGce({ project: 'ssfskim-ci-kit', token: async () => 'tok', fetchImpl: f.fetchImpl, sleep: async () => {} }) };
};

test('a missing instance reads as null, and its guest attribute as an error the caller can tell', async () => {
  const { gce } = gceWith([]);
  assert.equal(await gce.instance('us-central1-a', 'nope'), null);
  await assert.rejects(gce.guestAttribute('us-central1-a', 'nope', 'ci-kit/bake'), (e) => e instanceof GceError && e.status === 404);
});

test('a guest attribute not yet written reads as null; a written one as its value', async () => {
  const { gce } = gceWith([
    // Recorded shape: a queryPath with no value yet answers 404 with reason notFound.
    ['GET /zones/z/instances/b/getGuestAttributes?queryPath=ci-kit%2Fbake', json(404, NOT_FOUND)],
    ['GET /zones/z/instances/c/getGuestAttributes?queryPath=ci-kit%2Fbake', json(200, { kind: 'compute#guestAttributes', queryPath: 'ci-kit/bake', queryValue: { items: [{ namespace: 'ci-kit', key: 'bake', value: 'ok' }] } })],
    ['GET /zones/z/instances/', json(200, { name: 'b', status: 'RUNNING' })],
  ]);
  assert.equal(await gce.guestAttribute('z', 'b', 'ci-kit/bake'), null);
  assert.equal(await gce.guestAttribute('z', 'c', 'ci-kit/bake'), 'ok');
});

test('an insert waits for its zone operation and fails with the operation\'s error codes', async () => {
  const op = (status, error) => ({ kind: 'compute#operation', name: 'op-1', zone: `${BASE}/zones/z`, status, ...(error && { error }), selfLink: `${BASE}/zones/z/operations/op-1` });
  let waits = 0;
  const { gce, f } = gceWith([
    ['POST /zones/z/instances', json(200, op('RUNNING'))],
    ['POST /zones/z/operations/op-1/wait', () => {
      waits += 1;
      return json(200, waits < 2 ? op('RUNNING') : op('DONE', { errors: [{ code: 'ZONE_RESOURCE_POOL_EXHAUSTED', message: 'The zone does not have enough resources' }] }));
    }],
  ]);
  await assert.rejects(gce.insertInstance('z', { name: 'b' }), (e) => {
    assert.ok(e instanceof GceError);
    assert.deepEqual(e.codes, ['ZONE_RESOURCE_POOL_EXHAUSTED']);
    return true;
  });
  assert.equal(waits, 2);
  assert.deepEqual(f.calls[0].body, { name: 'b' });
  assert.equal(f.calls[0].auth, 'Bearer tok');
});

test('a request refused outright carries its reasons, as a quota refusal does', async () => {
  const { gce } = gceWith([['POST /zones/z/instances', json(403, { error: { code: 403, message: "Quota 'E2_CPUS' exceeded.", errors: [{ reason: 'quotaExceeded', message: 'x' }] } })]]);
  await assert.rejects(gce.insertInstance('z', { name: 'b' }), (e) => e.status === 403 && e.codes[0] === 'quotaExceeded' && /E2_CPUS/.test(e.message));
});

test('a delete of something already gone is done', async () => {
  const { gce } = gceWith([]);
  await gce.deleteInstance('z', 'gone');
  await gce.deleteImage('gone');
});

test('the aggregated instance list is flattened across zones and pages, and filtered by label server-side', async () => {
  const { gce, f } = gceWith([
    ['GET /aggregated/instances?filter=labels.ci-kit%3Dgce-builder&returnPartialSuccess=true&pageToken=p2', json(200, { items: { 'zones/b': { instances: [{ name: 'y' }] } } })],
    ['GET /aggregated/instances?filter=labels.ci-kit%3Dgce-builder&returnPartialSuccess=true', json(200, { items: { 'zones/a': { instances: [{ name: 'x' }] }, 'zones/c': { warning: { code: 'NO_RESULTS_ON_PAGE' } } }, nextPageToken: 'p2' })],
  ]);
  assert.deepEqual((await gce.instances('labels.ci-kit=gce-builder')).map((i) => i.name), ['x', 'y']);
  assert.equal(f.calls.length, 2);
});

test('image labels are set with the image\'s fingerprint, read fresh', async () => {
  const { gce, f } = gceWith([
    ['GET /global/images/i', json(200, { name: 'i', labels: { a: '1' }, labelFingerprint: 'fp1' })],
    ['POST /global/images/i/setLabels', json(200, { name: 'op-2', status: 'DONE', selfLink: `${BASE}/global/operations/op-2` })],
  ]);
  await gce.setImageLabels('i', { a: '1', b: '2' });
  assert.deepEqual(f.calls[1].body, { labels: { a: '1', b: '2' }, labelFingerprint: 'fp1' });
});

test('a secret is read as its latest version\'s text', async () => {
  const f = fake([['GET https://secretmanager.googleapis.com/v1/projects/ssfskim-ci-kit/secrets/ci-kit-app-id/versions/latest:access', json(200, { name: 'x', payload: { data: Buffer.from('5337915').toString('base64') } })]]);
  const gce = createGce({ project: 'ssfskim-ci-kit', token: async () => 'tok', fetchImpl: f.fetchImpl });
  assert.equal(await gce.secret('ci-kit-app-id'), '5337915');
});

test('the token comes from the metadata server on Cloud Run and from gcloud elsewhere, cached', async () => {
  let gcloud = 0;
  const local = accessToken({ env: {}, exec: async () => { gcloud += 1; return 'from-gcloud\n'; } });
  assert.equal(await local(), 'from-gcloud');
  assert.equal(await local(), 'from-gcloud');
  assert.equal(gcloud, 1);
  const urls = [];
  const cloud = accessToken({
    env: { CLOUD_RUN_JOB: 'ci-kit-bake' },
    fetchImpl: async (url, init) => {
      urls.push(`${url} ${init.headers['metadata-flavor']}`);
      return json(200, { access_token: 'from-metadata', expires_in: 3599, token_type: 'Bearer' });
    },
  });
  assert.equal(await cloud(), 'from-metadata');
  assert.deepEqual(urls, ['http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token Google']);
});
