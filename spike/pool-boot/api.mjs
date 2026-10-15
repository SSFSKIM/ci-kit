// Minimal Hetzner and GitHub clients for the M4 spike. Tokens are read from
// their sources at first use, kept in memory, and never printed.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

let hcloudToken, githubToken;

export async function hc(method, path, body) {
  hcloudToken ??= readFileSync(`${homedir()}/.config/claude-secrets/HETZNER_API_TOKEN`, 'utf8').trim();
  const res = await fetch(`https://api.hetzner.cloud/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${hcloudToken}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`hcloud ${method} ${path} → ${res.status} ${JSON.stringify(json.error ?? json)}`);
  return json;
}

export async function gh(method, path, body) {
  githubToken ??= execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
    redirect: 'follow',
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`github ${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => Date.now() / 1000;
export const iso = (s) => new Date(s * 1000).toISOString();
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export async function waitAction(id, timeoutS = 1800) {
  const t0 = now();
  for (;;) {
    const { action } = await hc('GET', `/actions/${id}`);
    if (action.status === 'success') return action;
    if (action.status === 'error') throw new Error(`action ${id} failed: ${JSON.stringify(action.error)}`);
    if (now() - t0 > timeoutS) throw new Error(`action ${id} timed out`);
    await sleep(5000);
  }
}

export async function ensureFirewall() {
  const { firewalls } = await hc('GET', '/firewalls?label_selector=ci-kit=spike');
  if (firewalls.length) return firewalls[0].id;
  const { firewall } = await hc('POST', '/firewalls', { name: 'ci-kit-spike', labels: { 'ci-kit': 'spike' }, rules: [] });
  return firewall.id;
}
