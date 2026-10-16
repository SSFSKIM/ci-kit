// The App's RS256 JWT and the installation-token cache (spec §3 Credentials), with a generated key and a fake API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
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
    if (url.endsWith('/app/installations')) return json([{ id: 9, account: { login: 'SSFSKIM' } }, { id: 8, account: { login: 'other' } }]);
    if (url.endsWith('/app/installations/9/access_tokens')) {
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
  const tokens = createAppTokens({ appId: '1', pem, owner: 'SSFSKIM', fetchImpl: api.fetchImpl, now: () => clock });
  assert.equal(await tokens(), 'tok-1');
  clock += 54 * 60_000;
  assert.equal(await tokens(), 'tok-1');
  clock += 2 * 60_000; // 56 min: inside the 5-min margin of a 13:00 expiry
  assert.equal(await tokens(), 'tok-2');
  assert.deepEqual(api.calls, ['GET /app/installations', 'POST /app/installations/9/access_tokens', 'POST /app/installations/9/access_tokens']);
});

test('an owner the App is not installed on is an error naming it', async () => {
  const api = fakeApi();
  const tokens = createAppTokens({ appId: '1', pem, owner: 'nobody', fetchImpl: api.fetchImpl });
  await assert.rejects(tokens(), /not installed on nobody/);
});

test('a scoped token asks GitHub for only the repositories and permissions it names', async () => {
  const bodies = [];
  const api = fakeApi();
  const fetchImpl = async (url, init) => {
    if (init.method === 'POST') bodies.push(JSON.parse(init.body));
    return api.fetchImpl(url, init);
  };
  const tokens = createAppTokens({ appId: '1', pem, owner: 'SSFSKIM', fetchImpl, scope: { repositories: ['MAWS'], permissions: { contents: 'read' } } });
  assert.equal(await tokens(), 'tok-1');
  assert.deepEqual(bodies, [{ repositories: ['MAWS'], permissions: { contents: 'read' } }]);
});
