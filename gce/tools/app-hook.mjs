#!/usr/bin/env node
// Points the GitHub App ci-kit-runners' webhook at the receiver (spec 2026-10-21 M4): its URL, JSON payloads, TLS
// verified, and the secret the receiver verifies against, through PATCH /app/hook/config as the App. The secret goes
// from Secret Manager to GitHub in memory and is never printed. Run by `gce/deploy.sh app-hook` once ci-kit-webhook is
// deployed, and again after the webhook secret is rotated; from the Mac, with gcloud's default account:
//   node gce/tools/app-hook.mjs <receiver url>
// Which events the App subscribes to, and whether its webhook is Active, are not in this API: they are the App's
// settings page (docs/pool.md, GCE, The webhook).
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { appJwt } from '../../lib/github-app.mjs';

const PROJECT = 'ssfskim-ci-kit';
const SECRET = 'ci-kit-webhook-secret';

// secret: as stored (surrounding whitespace dropped, as the receiver drops it). log(line): what was set, secret masked.
export async function setAppHook({ url, secret, appId, pem, fetchImpl = fetch, log }) {
  if (!/^https:\/\/[^\s/]+/.test(url)) throw new Error(`app-hook: the webhook URL must be https (${url})`);
  const key = secret.trim();
  if (!key) throw new Error('app-hook: the webhook secret is empty');
  const res = await fetchImpl('https://api.github.com/app/hook/config', {
    method: 'PATCH',
    headers: { authorization: `Bearer ${appJwt(appId, pem)}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
    body: JSON.stringify({ url, content_type: 'json', insecure_ssl: '0', secret: key }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`app-hook: PATCH /app/hook/config: HTTP ${res.status}`);
  const set = await res.json();
  log(`app-hook: the App delivers to ${set.url} (${set.content_type}, insecure_ssl=${set.insecure_ssl}, secret ${set.secret ? 'set' : 'NOT set'})`);
}

const access = (name) => execFileSync('gcloud', ['secrets', 'versions', 'access', 'latest', `--secret=${name}`, `--project=${PROJECT}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [url] = process.argv.slice(2);
  if (!url) {
    console.error('usage: node gce/tools/app-hook.mjs <receiver url>');
    process.exit(2);
  }
  setAppHook({ url, secret: access(SECRET), appId: access('ci-kit-app-id').trim(), pem: access('ci-kit-app-key'), log: console.log }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
