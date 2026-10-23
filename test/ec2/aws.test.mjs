import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAws, createCredentialProvider, googleIdToken } from '../../lib/aws.mjs';

const role = (account = '290475840169', name = 'launcher') => `arn:aws:iam::${account}:role/ci-kit-ec2-${name}`;
const start = Date.parse('2026-10-23T12:00:00Z');
function federation() {
  let time = start;
  const calls = [], audiences = [], logs = [];
  const sts = { async send(command) {
    calls.push(command.input);
    return { Credentials: { AccessKeyId: `key-${calls.length}`, SecretAccessKey: 'secret', SessionToken: 'session', Expiration: new Date(time + 14400_000) } };
  } };
  const options = { sts, tokenProvider: async (audience) => { audiences.push(audience); return 'google-token'; }, now: () => time, log: (line) => logs.push(line) };
  return { options, calls, audiences, logs, advance(ms) { time += ms; } };
}

test('role federation coalesces callers and refreshes before a 150 minute report lifetime is lost', async () => {
  const f = federation();
  const credentials = createCredentialProvider(role(), f.options);
  const [a, b] = await Promise.all([credentials(), credentials()]);
  assert.equal(a, b);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].RoleArn, role());
  assert.equal(f.calls[0].DurationSeconds, 14400);
  assert.equal(f.calls[0].WebIdentityToken, 'google-token');
  assert.deepEqual(f.audiences, ['https://ci-kit/290475840169/ec2']);
  assert.equal(a.expiration.toISOString(), '2026-10-23T16:00:00.000Z');
  f.advance(89 * 60_000);
  assert.equal((await credentials()).accessKeyId, 'key-1');
  f.advance(2 * 60_000);
  assert.equal((await credentials()).accessKeyId, 'key-2');
  assert.equal(f.calls.length, 2);
  assert.match(f.logs[0], /^aws: assumed arn:aws:iam::.* until /);
  assert.ok(f.logs.every(line => !/google-token|secret|session/.test(line)));
});

test('federation never shares credentials or audiences across roles and accounts', async () => {
  const f = federation();
  const a = createCredentialProvider(role(), f.options);
  const b = createCredentialProvider(role('111122223333'), f.options);
  const c = createCredentialProvider(role('290475840169', 'bake'), f.options);
  assert.deepEqual((await Promise.all([a(), b(), c()])).map(v => v.accessKeyId), ['key-1', 'key-2', 'key-3']);
  assert.deepEqual(f.audiences, ['https://ci-kit/290475840169/ec2', 'https://ci-kit/111122223333/ec2', 'https://ci-kit/290475840169/ec2']);
});

test('a failed refresh is retried, never replaced by operator credentials or stale presigning credentials', async () => {
  const f = federation();
  const credentials = createCredentialProvider(role(), f.options);
  await credentials();
  f.advance(100 * 60_000);
  const send = f.options.sts.send;
  f.options.sts.send = async () => { throw new Error('STS denied'); };
  await assert.rejects(credentials(), /STS denied/);
  f.options.sts.send = send;
  assert.equal((await credentials()).accessKeyId, 'key-2');
});

test('metadata token request uses account audience, Google header and a bounded timeout', async () => {
  let seen;
  const token = await googleIdToken('https://ci-kit/111122223333/ec2', { fetchImpl: async (url, options) => {
    seen = { url: new URL(url), options };
    return new Response('metadata-token');
  } });
  assert.equal(token, 'metadata-token');
  assert.equal(seen.url.hostname, 'metadata.google.internal');
  assert.equal(seen.url.searchParams.get('audience'), 'https://ci-kit/111122223333/ec2');
  assert.equal(seen.url.searchParams.get('format'), 'full');
  assert.equal(seen.options.headers['Metadata-Flavor'], 'Google');
  assert.ok(seen.options.signal instanceof AbortSignal);
  await assert.rejects(googleIdToken('x', { fetchImpl: async () => new Response('secret error', { status: 403 }) }), /HTTP 403/);
});

test('SDK clients pin regions, disable EC2 replay and sign report PUTs with refreshed credentials', async () => {
  const f = federation();
  const aws = createAws({ roleArn: role(), ...f.options });
  assert.equal(await aws.ec2.config.region(), 'us-east-2');
  assert.equal(await aws.ec2.config.maxAttempts(), 1);
  assert.equal(await aws.ce.config.region(), 'us-east-1');
  assert.equal((await aws.ce.config.endpoint()).hostname, 'ce.us-east-1.amazonaws.com');
  assert.equal(await aws.ssm.config.region(), 'us-east-2');
  const url = new URL(await aws.presignPut({ bucket: 'reports-bucket', key: 'reports/alloc/exit.json' }));
  assert.equal(url.pathname, '/reports/alloc/exit.json');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '9000');
  assert.equal(url.searchParams.get('X-Amz-Security-Token'), 'session');
  assert.match(url.searchParams.get('X-Amz-Credential'), /^key-1\//);
  f.advance(100 * 60_000);
  const refreshed = new URL(await aws.presignPut({ bucket: 'reports-bucket', key: 'reports/alloc/exit.json' }));
  assert.match(refreshed.searchParams.get('X-Amz-Credential'), /^key-2\//);
  await assert.rejects(aws.presignPut({ bucket: 'reports-bucket', key: 'reports/alloc/exit.json', expiresIn: 15000 }), /lifetime/);
});

test('SDK credential resolution preserves the provider refresh window instead of caching until five minutes remain', async () => {
  let time = Date.now(), calls = 0;
  const aws = createAws({ roleArn: role(), now: () => time, log: () => {}, tokenProvider: async () => 'google-token',
    sts: { async send() { return { Credentials: { AccessKeyId: `key-${++calls}`, SecretAccessKey: 'secret', SessionToken: 'session', Expiration: new Date(time + 14400_000) } }; } },
  });
  assert.equal((await aws.ec2.config.credentials()).accessKeyId, 'key-1');
  time += 100 * 60_000;
  assert.equal((await aws.ec2.config.credentials()).accessKeyId, 'key-2');
  assert.equal((await aws.s3.config.credentials()).accessKeyId, 'key-2');
});

test('invalid federation input and short STS sessions fail closed', async () => {
  assert.throws(() => createAws({}), /role ARN/);
  assert.throws(() => createAws({ roleArn: role(), region: 'us-west-2' }), /us-east-2/);
  const f = federation();
  f.options.sts.send = async () => ({ Credentials: { AccessKeyId: 'k', SecretAccessKey: 's', SessionToken: 't', Expiration: new Date(start + 3600_000) } });
  await assert.rejects(createCredentialProvider(role(), f.options)(), /session/);
});
