// A small GitHub REST client. Every call names its repo, so callers work from any directory.
// Authentication is the gh CLI's (`gh auth token`); each request times out after 20 s.
import { execFileSync } from 'node:child_process';

const API = 'https://api.github.com';
const TIMEOUT_MS = 20_000;

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The token gh is logged in with, or null when gh is missing or not authenticated.
export function ghToken() {
  try {
    const token = execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return token || null;
  } catch {
    return null;
  }
}

// Polled reads are conditional: the client keeps each GET's ETag and body, sends If-None-Match on the next call,
// and serves the cached body on a 304, which GitHub does not count against the token's rate limit. Every response's
// X-RateLimit-Remaining is recorded, so a poller can slow down before it drains the budget every session shares.
export function createGitHub(token, { fetchImpl = fetch, onRequest = () => {} } = {}) {
  const cache = new Map(); // path → { etag, body }
  const counts = { requests: 0, notModified: 0, remaining: null };

  async function request(method, path, { accept = 'application/vnd.github+json', text = false, conditional = false } = {}) {
    const headers = { authorization: `Bearer ${token}`, accept, 'x-github-api-version': '2022-11-28' };
    const cached = conditional ? cache.get(path) : undefined;
    if (cached) headers['if-none-match'] = cached.etag;
    const res = await fetchImpl(API + path, { method, headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    counts.requests += 1;
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining !== null) counts.remaining = Number(remaining);
    onRequest({ method, path, status: res.status, remaining: counts.remaining });

    if (res.status === 304 && cached) {
      counts.notModified += 1;
      return cached.body;
    }
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.json()).message ?? '';
      } catch {
        // a body that is not JSON adds nothing
      }
      throw new GitHubError(res.status, `HTTP ${res.status} ${method} ${path}${detail ? `: ${detail}` : ''}`);
    }
    if (res.status === 204 || res.status === 202) return null;
    const body = text ? await res.text() : await res.json();
    const etag = res.headers.get('etag');
    if (conditional && etag) cache.set(path, { etag, body });
    return body;
  }

  async function paged(path, key, { conditional = false } = {}) {
    const items = [];
    for (let page = 1; ; page += 1) {
      const sep = path.includes('?') ? '&' : '?';
      const body = await request('GET', `${path}${sep}per_page=100&page=${page}`, { conditional });
      items.push(...body[key]);
      if (body[key].length < 100) return items;
    }
  }

  return {
    request,
    // Requests made, how many were answered 304, and the token's last reported remaining budget.
    stats: () => ({ ...counts }),
    runsForCommit: (repo, sha) => paged(`/repos/${repo}/actions/runs?head_sha=${sha}`, 'workflow_runs', { conditional: true }),
    getRun: (repo, id) => request('GET', `/repos/${repo}/actions/runs/${id}`, { conditional: true }),
    listJobs: (repo, id) => paged(`/repos/${repo}/actions/runs/${id}/jobs?filter=latest`, 'jobs', { conditional: true }),
    jobLog: (repo, jobId) => request('GET', `/repos/${repo}/actions/jobs/${jobId}/logs`, { accept: '*/*', text: true }),
    annotations: (repo, checkRunId) => request('GET', `/repos/${repo}/check-runs/${checkRunId}/annotations?per_page=100`),
    runArtifacts: (repo, id) => paged(`/repos/${repo}/actions/runs/${id}/artifacts`, 'artifacts'),
    cancelRun: (repo, id) => request('POST', `/repos/${repo}/actions/runs/${id}/cancel`),
  };
}
