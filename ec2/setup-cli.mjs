#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { realpathSync } from 'node:fs';
import { identityClaims, setupAccount } from './setup-lib.mjs';
import { readAccount, operatorTokenProvider, proveBilling } from './setup-proof.mjs';
import { readGuardSubject } from './github-oidc.mjs';

const exec = promisify(execFile);
// The operator explicitly selects a profile. The runtime SDK module never uses this adapter.
export function operatorAws(profile, region = 'us-east-2') {
  if (!profile) throw new Error('setup: select an operator --profile or AWS_PROFILE');
  if (region !== 'us-east-2') throw new Error('setup: only us-east-2 is supported');
  return async (service, operation, input = {}) => {
    try {
      const { stdout } = await exec('aws', ['--profile', profile, '--region', region, '--no-cli-pager', '--output', 'json', service, operation, '--cli-input-json', JSON.stringify(input)],
        { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off' } });
      return stdout.trim() ? JSON.parse(stdout) : {};
    } catch (cause) {
      const code = /\(([^)]+)\) when calling/.exec(cause.stderr ?? '')?.[1];
      const error = new Error(`setup: ${service} ${operation} failed (${code ?? 'CLI error'})`);
      error.code = code;
      throw error;
    }
  };
}
async function operatorGitHub(path) {
  const { stdout } = await exec('gh', ['api', '--method', 'GET', path], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout);
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    config: { type: 'string' }, account: { type: 'string' }, profile: { type: 'string' },
    'google-service-account': { type: 'string' }, 'billing-proof': { type: 'boolean' }, 'update-policies': { type: 'boolean' }, 'repair-trust': { type: 'boolean' },
    since: { type: 'string' }, through: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: AWS_PROFILE=operator ec2/setup.sh [--config FILE] [--account ID] [--profile NAME]\n  [--google-service-account EMAIL] [--update-policies | --repair-trust] [--billing-proof] [--since DATE] [--through DATE]\nCreates missing resources; refuses existing drift by default. --update-policies prints current/desired policy diffs and replaces only each role\'s ci-kit-pool inline policy, with readback verification. Trust, duration, role identity and other policy attachments must still match. --repair-trust only repairs existing setup-managed GitHub role trust, printing the diff and verifying readback; permissions must match and no other resources are created. Authenticated gh reads repository identity and default OIDC subject settings; custom templates are refused. Billing proof is explicit (a paid read), and is required before enabling credit preference.');
    return;
  }
  if (values['repair-trust'] && values['update-policies']) throw new Error('setup: choose separate --repair-trust or --update-policies invocations');
  const config = await readAccount(values.config, values.account);
  const aws = operatorAws(values.profile ?? process.env.AWS_PROFILE, config.region);
  // Refuse the wrong profile before even asking Google for an impersonated token.
  const who = await aws('sts', 'get-caller-identity', {});
  if (who.Account !== config.account) throw new Error(`setup: operator account mismatch: expected ${config.account}, got ${who.Account}`);
  const guardSubject = await readGuardSubject(operatorGitHub);
  console.log(`setup: GitHub guard subject ${guardSubject}`);
  const tokenProvider = operatorTokenProvider(values['google-service-account']);
  const claims = identityClaims(await tokenProvider(`https://ci-kit/${config.account}/ec2`), config.account);
  const result = await setupAccount({ config, claims, guardSubject, aws, updatePolicies: values['update-policies'], repairTrust: values['repair-trust'] });
  if (values['billing-proof']) await proveBilling(result.config, { tokenProvider, since: values.since, through: values.through });
  else console.log('setup: billing proof pending; run ec2/setup.sh --billing-proof before enabling credit preference');
}
if (process.argv[1] && realpathSync(new URL(import.meta.url)) === realpathSync(process.argv[1])) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
