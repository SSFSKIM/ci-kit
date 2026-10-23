#!/usr/bin/env node
// Operator-only federation proof. Launch checks always set DryRun; this command cannot create an instance.
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { RunInstancesCommand } from '@aws-sdk/client-ec2';
import { GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import { createAws } from '../lib/aws.mjs';

const exec = promisify(execFile);
export const defaultConfig = fileURLToPath(new URL('../pool/config/ec2.json', import.meta.url));
export const defaultServiceAccount = 'ci-kit-launcher@ssfskim-ci-kit.iam.gserviceaccount.com';

export function selectAccount(config, account) {
  if (!Array.isArray(config.accounts)) throw new Error('setup: config must contain accounts');
  if (!account && config.accounts.length !== 1) throw new Error('setup: choose --account when multiple accounts are configured');
  const selected = account ? config.accounts.find(a => a.account === account) : config.accounts[0];
  if (!selected) throw new Error(`setup: account ${account} is not configured`);
  return selected;
}
export async function readAccount(file = defaultConfig, account) {
  return selectAccount(JSON.parse(await readFile(file, 'utf8')), account);
}
export function operatorTokenProvider(serviceAccount = defaultServiceAccount) {
  return async audience => {
    const { stdout } = await exec('gcloud', ['auth', 'print-identity-token', `--impersonate-service-account=${serviceAccount}`, `--audiences=${audience}`, '--include-email'], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    return stdout.trim();
  };
}

export function dryRunInput(config, { image, purpose }) {
  if (!/^ami-[\w-]+$/.test(image ?? '') || !['builder', 'smoke', 'job'].includes(purpose)) throw new Error('proof: --image ami-… and --purpose builder|smoke|job are required');
  const builder = purpose === 'builder';
  const tags = [
    { Key: 'ci-kit-pool', Value: 'ec2' }, { Key: 'ci-kit-purpose', Value: purpose },
    { Key: 'ci-kit-alloc', Value: 'dry-run-proof' }, { Key: 'ci-kit-repo', Value: 'SSFSKIM--ci-kit-sandbox' },
    { Key: 'ci-kit-deadline', Value: new Date(Date.now() + 30 * 60_000).toISOString() },
  ];
  return {
    DryRun: true, ImageId: image, InstanceType: 'c8a.large', MinCount: 1, MaxCount: 1,
    NetworkInterfaces: [{ DeviceIndex: 0, SubnetId: config.placements[0].subnet, Groups: [config.security_group], AssociatePublicIpAddress: true, DeleteOnTermination: true }],
    BlockDeviceMappings: [{ DeviceName: '/dev/sda1', Ebs: { VolumeType: 'gp3', VolumeSize: config.disk_gb ?? 50, Encrypted: true, DeleteOnTermination: true } }],
    InstanceInitiatedShutdownBehavior: builder ? 'stop' : 'terminate',
    ...(builder ? {} : { InstanceMarketOptions: { MarketType: 'spot', SpotOptions: { SpotInstanceType: 'one-time', InstanceInterruptionBehavior: 'terminate' } } }),
    MetadataOptions: { HttpTokens: 'required', HttpPutResponseHopLimit: 1, HttpProtocolIpv6: 'disabled' },
    TagSpecifications: ['instance', 'volume'].map(ResourceType => ({ ResourceType, Tags: tags })),
  };
}
export function billingInput(config, { since = config.credit?.since, through = new Date(Date.now() + 86400_000).toISOString().slice(0, 10) } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(through) || since >= through) throw new Error('proof: billing requires --since before --through (YYYY-MM-DD), or credit.since in config');
  return {
    TimePeriod: { Start: since, End: through }, Granularity: 'DAILY', Metrics: ['UnblendedCost'],
    Filter: { Dimensions: { Key: 'SERVICE', Values: ['Amazon Elastic Compute Cloud - Compute', 'EC2 - Other'] } },
    GroupBy: [{ Type: 'DIMENSION', Key: 'RECORD_TYPE' }],
  };
}
export async function proveBilling(config, { tokenProvider, since, through, log = console.log } = {}) {
  const aws = createAws({ roleArn: config.roles.launcher, region: config.region, tokenProvider, log });
  const input = billingInput(config, { since, through });
  await aws.ce.send(new GetCostAndUsageCommand(input));
  log(`proof: billing allowed through federated launcher ${config.account} ${input.TimePeriod.Start}..${input.TimePeriod.End}, ce.us-east-1.amazonaws.com`);
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    config: { type: 'string' }, account: { type: 'string' }, 'google-service-account': { type: 'string' },
    role: { type: 'string' }, image: { type: 'string' }, purpose: { type: 'string' }, expect: { type: 'string', default: 'allow' },
    billing: { type: 'boolean' }, since: { type: 'string' }, through: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: node ec2/setup-proof.mjs [--config FILE] [--account ID] [--google-service-account EMAIL]\n  --role bake|launcher --image AMI --purpose builder|smoke|job [--expect allow|deny]\n  --billing [--since YYYY-MM-DD] [--through YYYY-MM-DD]\nLaunch checks always use DryRun. No AWS profile or stored AWS credentials are used.');
    return;
  }
  const config = await readAccount(values.config, values.account);
  const tokenProvider = operatorTokenProvider(values['google-service-account']);
  if (values.billing) return proveBilling(config, { tokenProvider, since: values.since, through: values.through });
  if (!['bake', 'launcher'].includes(values.role) || !['allow', 'deny'].includes(values.expect)) throw new Error('proof: choose --role bake|launcher and --expect allow|deny');
  const input = dryRunInput(config, values);
  const aws = createAws({ roleArn: config.roles[values.role], region: config.region, tokenProvider });
  let outcome;
  try { await aws.ec2.send(new RunInstancesCommand(input)); } catch (error) {
    if (error.name === 'DryRunOperation') outcome = 'allow';
    else if (error.name === 'UnauthorizedOperation') outcome = 'deny';
    else throw error;
  }
  if (outcome !== values.expect) throw new Error(`proof: expected ${values.expect}, received ${outcome ?? 'unexpected successful DryRun response'}`);
  console.log(`proof: ${outcome} role=${values.role} image=${values.image} purpose=${values.purpose} (DryRun only)`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
