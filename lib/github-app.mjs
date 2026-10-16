// The GitHub App `ci-kit-runners` (spec §3 Credentials): an RS256 JWT signed with the App's key, exchanged for an
// installation token of the owner's installation. Tokens last an hour; one is re-minted 5 min before it expires.
import { createSign } from 'node:crypto';

const API = 'https://api.github.com';
const TIMEOUT_MS = 20_000;
const REFRESH_MARGIN_MS = 5 * 60_000;

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

// nowSeconds is backdated 60 s against clock drift; GitHub refuses an expiry more than 10 min ahead.
export function appJwt(appId, pem, nowSeconds = Math.floor(Date.now() / 1000)) {
  const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: String(appId) })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(pem, 'base64url');
  return `${unsigned}.${signature}`;
}

// Returns an async function that yields a valid installation token for `owner`. `scope` ({repositories, permissions})
// narrows each token to those repositories and permissions, as GitHub's access_tokens endpoint allows.
export function createAppTokens({ appId, pem, owner, fetchImpl = fetch, now = Date.now, scope }) {
  let installationId = null;
  let cached = null;

  async function call(method, path, bearer, body) {
    const res = await fetchImpl(API + path, {
      method,
      headers: { authorization: `Bearer ${bearer}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GitHub App ${method} ${path}: HTTP ${res.status}`);
    return res.json();
  }

  return async function token() {
    if (cached && cached.expires - now() > REFRESH_MARGIN_MS) return cached.token;
    const jwt = appJwt(appId, pem, Math.floor(now() / 1000));
    if (installationId === null) {
      const installs = await call('GET', '/app/installations', jwt);
      const mine = installs.find((i) => i.account?.login?.toLowerCase() === owner.toLowerCase());
      if (!mine) throw new Error(`ci-kit: the GitHub App is not installed on ${owner}`);
      installationId = mine.id;
    }
    const minted = await call('POST', `/app/installations/${installationId}/access_tokens`, jwt, scope);
    cached = { token: minted.token, expires: Date.parse(minted.expires_at) };
    return cached.token;
  };
}
