import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { STSClient } from '@aws-sdk/client-sts';
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import { GetServiceQuotaCommand } from '@aws-sdk/client-service-quotas';
import { createGuardAws } from '../../ec2/guard.mjs';
import { createAws } from '../../lib/aws.mjs';
import { fixture, prepared, instance, account } from './fake-ec2.mjs';

const roleArn = `arn:aws:iam::${account.account}:role/ci-kit-ec2-launcher`;
const credentials = now => ({ AccessKeyId: 'test-key', SecretAccessKey: 'test-secret', SessionToken: 'test-session', Expiration: new Date(now + 14400_000) });
const destroyAws = aws => { for (const client of Object.values(aws)) client?.destroy?.(); };

async function transport(t, respond) {
  // Exercise the production absolute deadline without spending thirty seconds per case. The separate
  // watchdog only makes missing-deadline RED runs finite; every test proves it did not cause the abort.
  const timeout = AbortSignal.timeout;
  let deadlinesElapsed = 0;
  t.mock.method(AbortSignal, 'timeout', ms => {
    const signal = timeout.call(AbortSignal, ms === 30_000 ? 1000 : ms);
    if (ms === 30_000) signal.addEventListener('abort', () => deadlinesElapsed++, { once: true });
    return signal;
  });
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = new URLSearchParams(Buffer.concat(chunks).toString());
    requests.push(input.get('Action'));
    respond(input, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  let watchdogFired = false;
  return {
    requests, watchdogFired: () => watchdogFired, deadlinesElapsed: () => deadlinesElapsed,
    route(client) {
      client.middlewareStack.add(next => async args => {
        Object.assign(args.request, { protocol: 'http:', hostname: '127.0.0.1', port: server.address().port });
        return next(args);
      }, { name: 'loopbackBodyTransport', step: 'finalizeRequest', priority: 'low' });
    },
    async send(send, options = {}) {
      const fallback = new AbortController();
      const timer = setTimeout(() => { watchdogFired = true; fallback.abort(); }, 3000);
      const signal = AbortSignal.any([...(options.abortSignal ? [options.abortSignal] : []), fallback.signal]);
      try { return await send({ ...options, abortSignal: signal }); }
      finally { clearTimeout(timer); }
    },
  };
}
const partial = (res, name) => { res.writeHead(200, { 'content-type': 'text/xml' }); res.write(`<${name}>`); };

function realRunTransport(f, aws, http, observe = () => {}) {
  const fakeSend = f.aws.ec2.send;
  f.aws.ec2.send = async (command, options) => {
    if (command.constructor.name !== 'RunInstancesCommand') return fakeSend(command);
    observe();
    return http.send(next => aws.ec2.send(command, next), options);
  };
}

test('absolute RunInstances deadline aborts a stalled response body and retains uncertain tag recovery without replay', async t => {
  const f = fixture();
  const http = await transport(t, (input, res) => {
    assert.equal(input.get('Action'), 'RunInstances');
    f.instances.push(instance()); // accepted before its incomplete response stalls
    partial(res, 'RunInstancesResponse');
  });
  const aws = createAws({ roleArn, tokenProvider: async () => 'test-token', log: () => {},
    sts: { send: async () => ({ Credentials: credentials(Date.now()) }) } });
  t.after(() => destroyAws(aws)); http.route(aws.ec2);
  let invocations = 0;
  realRunTransport(f, aws, http, () => invocations++);
  const result = await f.provider.launch(f.row, await prepared(f), 'test-jit');
  assert.equal(http.watchdogFired(), false, 'the production deadline, not the test watchdog, must abort body parsing');
  assert.equal(result.outcome, 'uncertain', 'possibly delivered requests cannot become definite refusals');
  assert.equal((await f.make().reconcileLaunch(f.row)).outcome, 'accepted');
  assert.equal(invocations, 1);
  assert.deepEqual(http.requests, ['RunInstances']);
});

test('absolute STS deadline aborts XML body parsing during refresh before any EC2 invocation or delivery', async t => {
  let now = Date.now(), calls = 0;
  const http = await transport(t, (input, res) => {
    assert.equal(input.get('Action'), 'AssumeRoleWithWebIdentity');
    if (++calls > 1) { partial(res, 'AssumeRoleWithWebIdentityResponse'); return; }
    const c = credentials(now);
    res.setHeader('content-type', 'text/xml');
    res.end(`<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>${c.AccessKeyId}</AccessKeyId><SecretAccessKey>${c.SecretAccessKey}</SecretAccessKey><SessionToken>${c.SessionToken}</SessionToken><Expiration>${c.Expiration.toISOString()}</Expiration></Credentials></AssumeRoleWithWebIdentityResult><ResponseMetadata><RequestId>test-request</RequestId></ResponseMetadata></AssumeRoleWithWebIdentityResponse>`);
  });
  const clients = new Set(), send = STSClient.prototype.send;
  t.mock.method(STSClient.prototype, 'send', function(command, options) {
    if (!clients.has(this)) { clients.add(this); http.route(this); }
    return http.send(next => send.call(this, command, next), options);
  });
  t.after(() => { for (const client of clients) client.destroy(); });
  const aws = createAws({ roleArn, tokenProvider: async () => 'test-token', now: () => now, log: () => {} });
  t.after(() => destroyAws(aws)); http.route(aws.ec2);
  await aws.credentials();
  now += 100 * 60_000;
  const f = fixture(); f.aws.presignPut = aws.presignPut;
  let invocations = 0;
  realRunTransport(f, aws, http, () => invocations++);
  const result = await f.provider.launch(f.row, await prepared(f), 'test-jit');
  assert.equal(http.watchdogFired(), false, 'headers must not end the runtime STS deadline');
  assert.equal(result.outcome, 'denied');
  assert.equal(invocations, 0);
  assert.deepEqual(http.requests, ['AssumeRoleWithWebIdentity', 'AssumeRoleWithWebIdentity']);
});

test('an EC2 operation aborted while SDK authentication waits never reaches HTTP after authentication resolves', async t => {
  const http = await transport(t, (_input, res) => partial(res, 'RunInstancesResponse'));
  let release, authenticated = false;
  const credentialsReady = new Promise(resolve => { release = resolve; });
  const send = EC2Client.prototype.send;
  t.mock.method(EC2Client.prototype, 'send', function(command, options) {
    // Release auth only after the operation's actual SDK deadline aborts, then observe whether HTTP is attempted.
    options.abortSignal.addEventListener('abort', release, { once: true });
    return send.call(this, command, options);
  });
  const aws = createAws({ roleArn, log: () => {},
    tokenProvider: async () => { await credentialsReady; authenticated = true; return 'test-token'; },
    sts: { send: async () => ({ Credentials: credentials(Date.now()) }) },
  });
  t.after(() => destroyAws(aws)); http.route(aws.ec2);
  const f = fixture();
  let invocations = 0;
  realRunTransport(f, aws, http, () => invocations++);
  const result = await f.provider.launch(f.row, await prepared(f), 'test-jit');
  assert.equal(http.watchdogFired(), false, 'the runtime operation deadline must fire while auth is pending');
  assert.equal(authenticated, true, 'the auth wait actually resolved after abortion');
  assert.equal(result.outcome, 'uncertain');
  assert.equal(invocations, 1);
  assert.deepEqual(http.requests, [], 'the SDK must reject the already-aborted operation before HTTP delivery');
});

const fakeFederation = { tokenProvider: async () => 'test-token', log: () => {},
  sts: { send: async () => ({ Credentials: credentials(Date.now()) }) } };
for (const [name, command, xml] of [
  ['ec2', () => new DescribeInstancesCommand({}), true],
  ['s3', () => new ListObjectsV2Command({ Bucket: 'test-bucket' }), true],
  ['ssm', () => new GetParameterCommand({ Name: '/test' }), false],
  ['ce', () => new GetCostAndUsageCommand({ TimePeriod: { Start: '2026-10-23', End: '2026-10-24' }, Granularity: 'DAILY', Metrics: ['UnblendedCost'] }), false],
  ['quotas', () => new GetServiceQuotaCommand({ ServiceCode: 'ec2', QuotaCode: 'test-quota' }), false],
]) {
  test(`${name} reads share the absolute body-consumption deadline`, async t => {
    const http = await transport(t, (_input, res) => {
      res.writeHead(200, { 'content-type': xml ? 'text/xml' : 'application/x-amz-json-1.1' });
      res.write(xml ? '<Response>' : '{');
    });
    const aws = createAws({ roleArn, ...fakeFederation });
    t.after(() => destroyAws(aws)); http.route(aws[name]);
    await assert.rejects(http.send(options => aws[name].send(command(), options)));
    assert.equal(http.watchdogFired(), false, `${name} must not rely on its caller to supply a deadline`);
    assert.equal(http.requests.length, 1, 'an aborted operation must not deliver a retry');
  });
}

test('S3 streaming Body stays bounded after send resolves at headers', async t => {
  const http = await transport(t, (_input, res) => { res.writeHead(200); res.write('partial object'); });
  const aws = createAws({ roleArn, ...fakeFederation });
  t.after(() => destroyAws(aws)); http.route(aws.s3);
  let gotHeaders = false;
  await assert.rejects(http.send(async options => {
    const response = await aws.s3.send(new GetObjectCommand({ Bucket: 'test-bucket', Key: 'reports/test/exit.json' }), options);
    gotHeaders = true;
    return response.Body.transformToString();
  }));
  assert.equal(gotHeaders, true, 'the response is a live stream, not an operation still waiting on headers');
  assert.equal(http.watchdogFired(), false, 'returning Body must not cancel its absolute abort timer');
  assert.equal(http.requests.length, 1);
});

test('caller cancellation still interrupts a read before the shared absolute deadline', async t => {
  const caller = new AbortController();
  const http = await transport(t, (_input, res) => { partial(res, 'DescribeInstancesResponse'); caller.abort(); });
  const aws = createAws({ roleArn, ...fakeFederation });
  t.after(() => destroyAws(aws)); http.route(aws.ec2);
  await assert.rejects(http.send(options => aws.ec2.send(new DescribeInstancesCommand({}), options), { abortSignal: caller.signal }));
  assert.equal(http.watchdogFired(), false);
  assert.equal(http.deadlinesElapsed(), 0, 'caller cancellation must not be replaced by the later default deadline');
  assert.equal(http.requests.length, 1);
});

const guardAccount = { account: account.account, region: 'us-east-2', roles: { guard: `arn:aws:iam::${account.account}:role/ci-kit-ec2-guard` } };
const guardOptions = { env: { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.com/oidc', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-request' },
  fetchImpl: async () => Response.json({ value: 'test-github-token' }), log: () => {} };

test('the independent guard EC2 constructor uses the same body deadline', async t => {
  const http = await transport(t, (_input, res) => partial(res, 'DescribeInstancesResponse'));
  const aws = await createGuardAws(guardAccount, { ...guardOptions, sts: fakeFederation.sts });
  t.after(() => aws.ec2.destroy()); http.route(aws.ec2);
  await assert.rejects(http.send(options => aws.ec2.send(new DescribeInstancesCommand({}), options)));
  assert.equal(http.watchdogFired(), false);
  assert.deepEqual(http.requests, ['DescribeInstances']);
});

test('the independent guard STS constructor uses the same body deadline', async t => {
  const http = await transport(t, (_input, res) => partial(res, 'AssumeRoleWithWebIdentityResponse'));
  const send = STSClient.prototype.send;
  t.mock.method(STSClient.prototype, 'send', function(command, options) {
    http.route(this);
    return http.send(next => send.call(this, command, next), options);
  });
  await assert.rejects(createGuardAws(guardAccount, guardOptions));
  assert.equal(http.watchdogFired(), false);
  assert.deepEqual(http.requests, ['AssumeRoleWithWebIdentity']);
});
