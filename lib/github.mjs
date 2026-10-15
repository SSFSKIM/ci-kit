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

export function createGitHub(token, { fetchImpl = fetch } = {}) {
  async function request(method, path, { accept = 'application/vnd.github+json', text = false } = {}) {
    const res = await fetchImpl(API + path, {
      method,
      headers: { authorization: `Bearer ${token}`, accept, 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
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
    return text ? res.text() : res.json();
  }

  async function paged(path, key) {
    const items = [];
    for (let page = 1; ; page += 1) {
      const sep = path.includes('?') ? '&' : '?';
      const body = await request('GET', `${path}${sep}per_page=100&page=${page}`);
      items.push(...body[key]);
      if (body[key].length < 100) return items;
    }
  }

  return {
    request,
    runsForCommit: (repo, sha) => paged(`/repos/${repo}/actions/runs?head_sha=${sha}`, 'workflow_runs'),
    getRun: (repo, id) => request('GET', `/repos/${repo}/actions/runs/${id}`),
    listJobs: (repo, id) => paged(`/repos/${repo}/actions/runs/${id}/jobs?filter=latest`, 'jobs'),
    jobLog: (repo, jobId) => request('GET', `/repos/${repo}/actions/jobs/${jobId}/logs`, { accept: '*/*', text: true }),
    annotations: (repo, checkRunId) => request('GET', `/repos/${repo}/check-runs/${checkRunId}/annotations?per_page=100`),
    runArtifacts: (repo, id) => paged(`/repos/${repo}/actions/runs/${id}/artifacts`, 'artifacts'),
    cancelRun: (repo, id) => request('POST', `/repos/${repo}/actions/runs/${id}/cancel`),
  };
}
