#!/usr/bin/env node
// Check the App's repository grants before changing the pool's served set. Never prints credentials.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGce, accessToken } from '../../lib/gce.mjs';
import { createAppTokens } from '../../lib/github-app.mjs';
import { parseGceConfig } from '../launcher/config.mjs';

async function loadApp() {
  const cfg = parseGceConfig(readFileSync(new URL('../../pool/config/gce.json', import.meta.url), 'utf8'));
  const gce = createGce({ project: cfg.project, token: accessToken() });
  return { appId: (await gce.secret('ci-kit-app-id')).trim(), pem: await gce.secret('ci-kit-app-key') };
}

export async function appAccess(repos, { loadApp: readApp = loadApp, log = console.log, error = console.error } = {}) {
  if (!repos.length || repos.some(repo => !/^[\w.-]+\/[\w.-]+$/.test(repo))) {
    throw new Error('usage: node gce/tools/app-access.mjs <owner/repo>...');
  }
  const app = await readApp();
  let failed = false;
  for (const repo of repos) {
    try {
      // A fresh lookup for each repo is intentional: an owner's installation may exclude a sibling repo.
      const token = createAppTokens({ ...app, repo, scope: { repositories: [repo.split('/')[1]] } });
      const installation = await token.installation();
      await token();
      log(`${repo}: account ${installation.account.login}, installation ${installation.id}, access OK`);
    } catch (err) {
      failed = true;
      error(`${repo}: ${err.message}`);
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  appAccess(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(err => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
