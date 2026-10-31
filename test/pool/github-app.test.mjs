// The App's RS256 JWT and the installation-token cache (spec §3 Credentials), with a generated key and a fake API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { createGitHub } from '../../lib/github.mjs';
import { appJwt, createAppTokens } from '../../lib/github-app.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString());

test('appJwt is an RS256 JWT the public key verifies, issued by the App, backdated 60 s and valid under 10 min', () => {
  const jwt = appJwt('5337915', pem, 1_000_000);
  const [h, p, sig] = jwt.split('.');
  assert.deepEqual(decode(h), { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(decode(p), { iat: 999_940, exp: 1_000_540, iss: '5337915' });
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, sig, 'base64url'));
});

function fakeApi() {
  const calls = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    calls.push(`${init.method} ${new URL(url).pathname}`);
    const json = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    // The real installation is beyond page one. Listing is forbidden, even with pagination.
    if (url.endsWith('/app/installations')) {
      const installations = [...Array.from({ length: 30 }, (_, id) => ({ id, account: { login: `stranger-${id}` } })), { id: 90, account: { login: 'SSFSKIM' } }];
      assert.fail(`must resolve directly, not list ${installations.length} installations`);
    }
    if (url.endsWith('/repos/SSFSKIM/MAWS/installation')) return json({ id: 90, account: { login: 'SSFSKIM' } });
    if (url.endsWith('/repos/neworg/MAWS/installation')) return json({ id: 91, account: { login: 'neworg' } });
    if (url.endsWith('/app/installations/91/access_tokens')) return json({ token: 'org-token', expires_at: '2026-10-15T13:00:00Z' });
    if (url.endsWith('/app/installations/90/access_tokens')) {
      n += 1;
      return json({ token: `tok-${n}`, expires_at: new Date(Date.parse('2026-10-15T13:00:00Z')).toISOString() });
    }
    return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }), text: async () => '' };
  };
  return { calls, fetchImpl };
}

test('the installation token is minted for the owner\'s installation, cached, and re-minted 5 min before it expires', async () => {
  const api = fakeApi();
  let clock = Date.parse('2026-10-15T12:00:00Z');
  const tokens = createAppTokens({ appId: '1', pem, repo: 'SSFSKIM/MAWS', fetchImpl: api.fetchImpl, now: () => clock });
  assert.equal(await tokens(), 'tok-1');
  clock += 54 * 60_000;
  assert.equal(await tokens(), 'tok-1');
  clock += 2 * 60_000; // 56 min: inside the 5-min margin of a 13:00 expiry
  assert.equal(await tokens(), 'tok-2');
  assert.deepEqual(api.calls, ['GET /repos/SSFSKIM/MAWS/installation', 'POST /app/installations/90/access_tokens', 'POST /app/installations/90/access_tokens']);
});

test('a repo outside a selected-repository installation is an error naming the missing grant', async () => {
  const api = fakeApi();
  const tokens = createAppTokens({ appId: '1', pem, repo: 'SSFSKIM/excluded', fetchImpl: api.fetchImpl });
  await assert.rejects(tokens(), /not installed on SSFSKIM\/excluded.*selected/i);
});

test('a scoped token asks GitHub for only the repositories and permissions it names', async () => {
  const bodies = [];
  const api = fakeApi();
  const fetchImpl = async (url, init) => {
    if (init.method === 'POST') bodies.push(JSON.parse(init.body));
    return api.fetchImpl(url, init);
  };
  const tokens = createAppTokens({ appId: '1', pem, repo: 'SSFSKIM/MAWS', fetchImpl, scope: { repositories: ['MAWS'], permissions: { contents: 'read' } } });
  assert.equal(await tokens(), 'tok-1');
  assert.deepEqual(bodies, [{ repositories: ['MAWS'], permissions: { contents: 'read' } }]);
});

test('one client routes two owners to their installations and caches each owner across repositories', async () => {
  const api = fakeApi();
  const tokens = createAppTokens({ appId: '1', pem, fetchImpl: api.fetchImpl, now: () => Date.parse('2026-10-15T12:00:00Z') });
  const auth = [];
  const gh = createGitHub(tokens, { fetchImpl: async (url, init) => {
    auth.push([new URL(url).pathname, init.headers.authorization]);
    return new Response('{}');
  } });
  await gh.getRepo('SSFSKIM/MAWS');
  await gh.getRepo('neworg/MAWS');
  await gh.getRepo('SSFSKIM/ci-kit-sandbox');
  assert.deepEqual(auth, [
    ['/repos/SSFSKIM/MAWS', 'Bearer tok-1'],
    ['/repos/neworg/MAWS', 'Bearer org-token'],
    ['/repos/SSFSKIM/ci-kit-sandbox', 'Bearer tok-1'],
  ]);
  assert.deepEqual(api.calls, [
    'GET /repos/SSFSKIM/MAWS/installation', 'POST /app/installations/90/access_tokens',
    'GET /repos/neworg/MAWS/installation', 'POST /app/installations/91/access_tokens',
  ]);
});
