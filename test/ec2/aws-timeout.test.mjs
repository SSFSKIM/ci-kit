import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { STSClient } from '@aws-sdk/client-sts';
import { createAws } from '../../lib/aws.mjs';
import { Launcher } from '../../gce/launcher/launcher.mjs';
import { createProviders } from '../../gce/launcher/providers/index.mjs';
import { createGceLedger } from '../../gce/launcher/ledger-store.mjs';
import { world } from '../gce/fake-world.mjs';
import { ONE_REGION_CFG } from '../gce/config-fixtures.mjs';
import { fixture, account, start, prepared, instance } from './fake-ec2.mjs';

const roleArn = `arn:aws:iam::${account.account}:role/ci-kit-ec2-launcher`;
async function serverFor(t, receive) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = new URLSearchParams(Buffer.concat(chunks).toString());
    requests.push(input.get('Action'));
    receive(input, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { port: server.address().port, requests };
}

// Keep the real SDK client's production handler and timeout mode. Only its duration and network destination
// change for a short, offline characterization. The safety abort makes warning-only behavior fail finitely.
function loopback(client, server, warnings) {
  client.config.requestHandler.updateHttpClientConfig('logger', { warn: message => warnings.push(message) });
  client.middlewareStack.add(next => async args => {
    Object.assign(args.request, { protocol: 'http:', hostname: '127.0.0.1', port: server.port });
    return next(args);
  }, { name: 'loopbackTransport', step: 'finalizeRequest', priority: 'low' });
}
const destroyAws = aws => { for (const client of Object.values(aws)) client?.destroy?.(); };

test('real RunInstances request timeout rejects, stays uncertain, and reconciles by tag/token without replay', async t => {
  const f = fixture(), warnings = [];
  const server = await serverFor(t, (input) => {
    assert.equal(input.get('Action'), 'RunInstances');
    // AWS accepted the request, but its response never arrives.
    f.instances.push(instance());
  });
  const aws = createAws({ roleArn, tokenProvider: async () => 'test-google-token', log: () => {},
    sts: { send: async () => ({ Credentials: { AccessKeyId: 'test-key', SecretAccessKey: 'test-secret', SessionToken: 'test-session', Expiration: new Date(Date.now() + 14400_000) } }) } });
  t.after(() => destroyAws(aws));
  loopback(aws.ec2, server, warnings);
  let invocation = 0, transportError;
  const fakeSend = f.aws.ec2.send;
  f.aws.ec2.send = async command => {
    if (command.constructor.name !== 'RunInstancesCommand') return fakeSend(command);
    invocation++;
    try { return await aws.ec2.send(command, { requestTimeout: 1000, abortSignal: AbortSignal.timeout(5000) }); }
    catch (error) { transportError = error; throw error; }
  };
  const c = await prepared(f);
  const result = await f.provider.launch(f.row, c, 'test-jit');
  assert.equal(transportError.name, 'TimeoutError', 'production requestTimeout must reject, not wait for the test safety abort');
  assert.equal(transportError.code, 'ETIMEDOUT');
  assert.equal(transportError.$metadata.attempts, 1);
  assert.equal(result.outcome, 'uncertain', 'a timeout cannot establish definite refusal');
  const recovered = await f.make().reconcileLaunch(f.row);
  assert.equal(recovered.outcome, 'accepted');
  assert.equal(recovered.id, 'i-123');
  const queries = f.calls.filter(([name]) => name === 'DescribeInstances').map(([, input]) => input.Filters ?? []);
  assert.ok(queries.some(filters => filters.some(x => x.Name === 'tag:ci-kit-alloc' && x.Values[0] === f.row.alloc)));
  assert.ok(queries.some(filters => filters.some(x => x.Name === 'client-token' && x.Values[0] === f.row.client_token)));
  assert.equal(invocation, 1);
  assert.deepEqual(server.requests, ['RunInstances'], 'HTTP delivery count proves no SDK replay');
  assert.deepEqual(warnings, []);
});

test('real STS timeout during refresh prevents a launcher tick from invoking or delivering RunInstances', async t => {
  const warnings = [], clients = new Set();
  let now = Date.now(), calls = 0, refreshError;
  const server = await serverFor(t, (input, res) => {
    if (input.get('Action') !== 'AssumeRoleWithWebIdentity') return;
    if (++calls !== 1) return; // refresh hangs; the initial session succeeds
    res.setHeader('content-type', 'text/xml');
    res.end(`<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>test-key</AccessKeyId><SecretAccessKey>test-secret</SecretAccessKey><SessionToken>test-session</SessionToken><Expiration>${new Date(now + 14400_000).toISOString()}</Expiration></Credentials></AssumeRoleWithWebIdentityResult><ResponseMetadata><RequestId>test-request</RequestId></ResponseMetadata></AssumeRoleWithWebIdentityResponse>`);
  });
  const send = STSClient.prototype.send;
  t.mock.method(STSClient.prototype, 'send', async function(command) {
    if (!clients.has(this)) { clients.add(this); loopback(this, server, warnings); }
    try { return await send.call(this, command, { requestTimeout: 1000, abortSignal: AbortSignal.timeout(5000) }); }
    catch (error) { refreshError = error; throw error; }
  });
  t.after(() => { for (const client of clients) client.destroy(); });
  const aws = createAws({ roleArn, tokenProvider: async () => 'test-google-token', now: () => now, log: () => {} });
  t.after(() => destroyAws(aws));
  loopback(aws.ec2, server, warnings);
  await aws.credentials();
  now += 100 * 60_000; // less than 150 minutes remain: presigning must refresh, not use the old session

  const w = world({ start }), f = fixture(), repo = 'SSFSKIM/ci-kit-sandbox';
  const cfg = { ...ONE_REGION_CFG, repos: [{ repo, providers: [{ provider: 'ec2', account: account.account }] }] };
  const ec2 = { enabled: true, accounts: [{ ...account, roles: { launcher: roleArn } }] };
  f.aws.presignPut = aws.presignPut;
  let ec2Invocations = 0;
  const fakeSend = f.aws.ec2.send;
  f.aws.ec2.send = command => {
    if (command.constructor.name !== 'RunInstancesCommand') return fakeSend(command);
    ec2Invocations++;
    return aws.ec2.send(command, { requestTimeout: 1000, abortSignal: AbortSignal.timeout(5000) });
  };
  const providers = createProviders({ gce: w.gce, cfg, ec2, config: 'timeout', now: w.now, awsFactory: () => f.aws });
  const ledger = createGceLedger(w.github, cfg.ledger, { now: w.now });
  w.sim.queue(repo, ['self-hosted', 'ci-kit-pool', 'cpus-8', 'ci-kit-ec2']);
  const out = await new Launcher({ provider: providers[0], providers, ec2, cfg, config: 'timeout', gh: w.github, ledger,
    poolRepos: [], now: w.now, after: w.after }).tick();
  assert.equal(refreshError.name, 'TimeoutError', 'the runtime-created STS handler must abort its hung request');
  assert.equal(refreshError.code, 'ETIMEDOUT');
  assert.equal(refreshError.$metadata.attempts, 1);
  assert.equal(out.launched.length, 0);
  assert.equal(ec2Invocations, 0);
  assert.deepEqual(server.requests, ['AssumeRoleWithWebIdentity', 'AssumeRoleWithWebIdentity']);
  assert.equal((await ledger.rows())[0].end, 'refused', 'authentication failure is definite before any EC2 send');
  assert.deepEqual(warnings, []);
});
