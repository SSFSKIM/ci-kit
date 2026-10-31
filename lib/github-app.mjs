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

// token(repo) routes by repository owner; a fixed `repo` also supports callers that ask with no argument.
// Installations and expiring tokens are cached per owner. `scope` narrows the minted token's grants.
export function createAppTokens({ appId, pem, repo, fetchImpl = fetch, now = Date.now, scope }) {
  const installations = new Map(), tokens = new Map();
  const ownerOf = (target) => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(target ?? '')) throw new Error('ci-kit: GitHub App requires owner/repo');
    return target.split('/')[0].toLowerCase();
  };
  async function call(method, path, bearer, body) {
    const res = await fetchImpl(API + path, {
      method,
      headers: { authorization: `Bearer ${bearer}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw Object.assign(new Error(`GitHub App ${method} ${path}: HTTP ${res.status}`), { status: res.status });
    return res.json();
  }

  async function installation(target = repo) {
    const owner = ownerOf(target);
    if (!installations.has(owner)) {
      const jwt = appJwt(appId, pem, Math.floor(now() / 1000));
      try {
        installations.set(owner, await call('GET', `/repos/${target}/installation`, jwt));
      } catch (error) {
        if (error.status === 404) throw new Error(`ci-kit: the GitHub App is not installed on ${target}; check the account installation and its selected repositories`);
        throw error;
      }
    }
    return installations.get(owner);
  }

  async function token(target = repo) {
    const owner = ownerOf(target), cached = tokens.get(owner);
    if (cached && cached.expires - now() > REFRESH_MARGIN_MS) return cached.token;
    const { id } = await installation(target);
    const jwt = appJwt(appId, pem, Math.floor(now() / 1000));
    const minted = await call('POST', `/app/installations/${id}/access_tokens`, jwt, scope);
    tokens.set(owner, { token: minted.token, expires: Date.parse(minted.expires_at) });
    return minted.token;
  }
  token.installation = installation;
  return token;
}
