#!/usr/bin/env node
// The Cloud Run service ci-kit-webhook (spec 2026-10-21 M4): public, no invoker IAM check, so GitHub can deliver to
// it; the signature is its only gate (receiver.mjs). It runs as ci-kit-webhook@, which may read the webhook secret and
// publish to the topic ci-kit-tick-requests, and nothing else. The secret is a Cloud Run secret volume, which fetches
// the latest version on each read, so a rotation reaches the receiver without a deploy.
// Which repos are served is read from the gce.json and pool.json bundled with this deploy: a repo added on main
// reaches the receiver at its next deploy, and until then its jobs wait for the scheduled tick as before M4.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { accessToken } from '../../lib/gce.mjs';
import { parseGceConfig, servedRepos } from '../launcher/config.mjs';
import { poolRepos } from '../launcher/source.mjs';
import { createReceiver, createPublisher } from './receiver.mjs';

const bundled = (name) => readFileSync(new URL(`../../pool/config/${name}`, import.meta.url), 'utf8');
const say = (severity, message, extra = {}) => console.log(JSON.stringify({ severity, message, ...extra }));

const cfg = parseGceConfig(bundled('gce.json'));
const { served } = servedRepos(cfg.repos, poolRepos(bundled('pool.json')));
const topic = process.env.CI_KIT_TOPIC;
const secretFile = process.env.CI_KIT_WEBHOOK_SECRET_FILE;
if (!topic || !secretFile) throw new Error('ci-kit-webhook: CI_KIT_TOPIC and CI_KIT_WEBHOOK_SECRET_FILE must be set (gce/deploy.sh webhook)');

const receive = createReceiver({
  secret: () => readFile(secretFile, 'utf8'),
  publish: createPublisher({ topic, token: accessToken() }),
  served: new Set(served.map((r) => r.toLowerCase())),
  machines: cfg.placements[0].machines, // every placement names every size
  log: say,
});

http.createServer(receive).listen(Number(process.env.PORT) || 8080, () =>
  say('INFO', `ci-kit-webhook listening, kit ${(process.env.CI_KIT_COMMIT || 'bundled').slice(0, 8)}, serving ${served.join(', ')}`));
