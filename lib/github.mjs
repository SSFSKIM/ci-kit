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
// GitHub's responses report more than one window at a time (different X-RateLimit-Reset values from different
// endpoints in the same poll), so the budget reported is the lowest among the windows not yet reset.
// token: a string, or an async function returning one (the pool's App installation tokens, which expire).
export function createGitHub(token, { fetchImpl = fetch, onRequest = () => {}, now = Date.now } = {}) {
  const cache = new Map(); // path → { etag, body }
  const counts = { requests: 0, notModified: 0 };
  const windows = new Map(); // X-RateLimit-Reset (epoch s, or 'unknown') → the last remaining reported for it
  // The lowest remaining among the windows not yet reset, and that window's reset (epoch s, or null when unknown).
  const budget = () => {
    const open = [...windows].filter(([reset]) => reset === 'unknown' || reset * 1000 > now());
    if (open.length === 0) return { remaining: null, reset: null };
    const [reset, remaining] = open.reduce((low, w) => (w[1] < low[1] ? w : low));
    return { remaining, reset: reset === 'unknown' ? null : reset };
  };

  async function request(method, path, { accept = 'application/vnd.github+json', text = false, conditional = false, body } = {}) {
    const bearer = typeof token === 'function' ? await token() : token;
    const headers = { authorization: `Bearer ${bearer}`, accept, 'x-github-api-version': '2022-11-28' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const cached = conditional ? cache.get(path) : undefined;
    if (cached) headers['if-none-match'] = cached.etag;
    counts.requests += 1; // an attempt counts, whether or not an answer comes back
    let res;
    try {
      res = await fetchImpl(API + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      onRequest({ method, path, status: `failed: ${e.message}`, remaining: null });
      throw e;
    }
    const left = res.headers.get('x-ratelimit-remaining');
    if (left !== null) {
      const reset = res.headers.get('x-ratelimit-reset');
      windows.set(reset === null ? 'unknown' : Number(reset), Number(left));
    }
    onRequest({ method, path, status: res.status, remaining: left === null ? null : Number(left) });

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
    const answer = text ? await res.text() : await res.json();
    const etag = res.headers.get('etag');
    if (conditional && etag) cache.set(path, { etag, body: answer });
    return answer;
  }

  async function paged(path, key, { conditional = false } = {}) {
    const items = [];
    for (let page = 1; ; page += 1) {
      const sep = path.includes('?') ? '&' : '?';
      const body = await request('GET', `${path}${sep}per_page=100&page=${page}`, { conditional });
      // key null: the endpoint returns a bare array
      const batch = key === null ? body : body[key];
      items.push(...batch);
      if (batch.length < 100) return items;
    }
  }

  return {
    request,
    // Requests attempted, how many were answered 304, and the token's budget: { remaining, reset } of the lowest window.
    stats: () => ({ ...counts, ...budget() }),
    runsForCommit: (repo, sha) => paged(`/repos/${repo}/actions/runs?head_sha=${sha}`, 'workflow_runs', { conditional: true }),
    getRun: (repo, id) => request('GET', `/repos/${repo}/actions/runs/${id}`, { conditional: true }),
    listJobs: (repo, id) => paged(`/repos/${repo}/actions/runs/${id}/jobs?filter=latest`, 'jobs', { conditional: true }),
    jobLog: (repo, jobId) => request('GET', `/repos/${repo}/actions/jobs/${jobId}/logs`, { accept: '*/*', text: true }),
    annotations: (repo, checkRunId) => request('GET', `/repos/${repo}/check-runs/${checkRunId}/annotations?per_page=100`),
    runArtifacts: (repo, id) => paged(`/repos/${repo}/actions/runs/${id}/artifacts`, 'artifacts'),
    cancelRun: (repo, id) => request('POST', `/repos/${repo}/actions/runs/${id}/cancel`),
    // The pool's calls (spec §3). The agent polls its run and runner listings every 10 s, so those are conditional:
    // an unchanged listing is a 304, which costs the App's installation token nothing.
    getRepo: (repo) => request('GET', `/repos/${repo}`),
    runsByStatus: (repo, status) => paged(`/repos/${repo}/actions/runs?status=${status}`, 'workflow_runs', { conditional: true }),
    runners: (repo) => paged(`/repos/${repo}/actions/runners`, 'runners', { conditional: true }),
    deleteRunner: (repo, id) => request('DELETE', `/repos/${repo}/actions/runners/${id}`),
    jitConfig: (repo, spec) =>
      request('POST', `/repos/${repo}/actions/runners/generate-jitconfig`, { body: { runner_group_id: 1, work_folder: '_work', ...spec } }),
    // The newest commit on `ref` that changed `path` (the agent's config label, spec §3a).
    lastCommit: async (repo, path, ref = 'main') =>
      (await request('GET', `/repos/${repo}/commits?sha=${ref}&path=${encodeURIComponent(path)}&per_page=1`, { conditional: true }))[0] ?? null,
    enableWorkflow: (repo, file) => request('PUT', `/repos/${repo}/actions/workflows/${file}/enable`),
    openIssues: (repo, label) =>
      paged(`/repos/${repo}/issues?state=open${label ? `&labels=${encodeURIComponent(label)}` : ''}`, null),
    createIssue: (repo, issue) => request('POST', `/repos/${repo}/issues`, { body: issue }),
    ensureLabel: async (repo, name, color) => {
      try {
        await request('GET', `/repos/${repo}/labels/${encodeURIComponent(name)}`);
      } catch (err) {
        if (err.status !== 404) throw err;
        await request('POST', `/repos/${repo}/labels`, { body: { name, color } });
      }
    },
    issueComments: (repo, issue) => paged(`/repos/${repo}/issues/${issue}/comments`, null),
    createComment: (repo, issue, body) => request('POST', `/repos/${repo}/issues/${issue}/comments`, { body: { body } }),
    updateComment: (repo, id, body) => request('PATCH', `/repos/${repo}/issues/comments/${id}`, { body: { body } }),
    deleteComment: (repo, id) => request('DELETE', `/repos/${repo}/issues/comments/${id}`),
  };
}
