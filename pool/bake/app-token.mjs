#!/usr/bin/env node
// Prints an installation token for the Hetzner bake's cache warming (pool/bake/builder.sh's warm_token), minted from
// the App credentials that bake writes to /etc/ci-kit, and narrowed to what warming reads (WARM_SCOPE). The token goes
// to the caller's stdout only, which passes it to warm.mjs through its environment.
import { readFile } from 'node:fs/promises';
import { createAppTokens } from '../../lib/github-app.mjs';
import { WARM_SCOPE } from './warm.mjs';

const ETC = process.env.CI_KIT_ETC ?? '/etc/ci-kit';
const mint = createAppTokens({
  appId: (await readFile(`${ETC}/app_id`, 'utf8')).trim(),
  pem: await readFile(`${ETC}/app.pem`, 'utf8'),
  owner: 'SSFSKIM',
  scope: WARM_SCOPE,
});
process.stdout.write(await mint());
