// Pointing the GitHub App's webhook at the receiver (spec 2026-10-21 M4): PATCH /app/hook/config as the App, the
// secret sent and never shown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setAppHook } from '../../gce/tools/app-hook.mjs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' });
const SECRET = '5b0c2f8e9d7a46b1a3c5e7f9d1b3a5c7';

function github(status = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    const body = { content_type: 'json', insecure_ssl: '0', secret: '********', url: calls.at(-1).body?.url ?? 'x' };
    return new Response(JSON.stringify(status === 200 ? body : { message: 'Bad credentials' }), { status });
  };
  return { calls, fetchImpl };
}

test('the hook config is set as the App: the receiver URL, JSON, TLS verified, and the secret', async () => {
  const g = github();
  const lines = [];
  await setAppHook({ url: 'https://ci-kit-webhook-dfl3aowzma-uc.a.run.app', secret: `${SECRET}\n`, appId: '5337915', pem: PEM, fetchImpl: g.fetchImpl, log: (l) => lines.push(l) });
  assert.equal(g.calls.length, 1);
  const [call] = g.calls;
  assert.deepEqual([call.method, call.url], ['PATCH', 'https://api.github.com/app/hook/config']);
  assert.match(call.headers.authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/); // the App's JWT, not a user token
  assert.deepEqual(call.body, { url: 'https://ci-kit-webhook-dfl3aowzma-uc.a.run.app', content_type: 'json', insecure_ssl: '0', secret: SECRET });
  assert.ok(lines.length > 0);
  assert.ok(lines.every((l) => !l.includes(SECRET)));
});

test('a URL that is not https, or an empty secret, is refused before any call', async () => {
  const g = github();
  await assert.rejects(setAppHook({ url: 'http://example.com/hook', secret: SECRET, appId: '1', pem: PEM, fetchImpl: g.fetchImpl, log: () => {} }), /https/);
  await assert.rejects(setAppHook({ url: 'https://example.com/hook', secret: ' \n', appId: '1', pem: PEM, fetchImpl: g.fetchImpl, log: () => {} }), /secret/);
  assert.equal(g.calls.length, 0);
});

test('a refused PATCH throws with its status and never the secret', async () => {
  const g = github(401);
  await assert.rejects(
    setAppHook({ url: 'https://example.com/hook', secret: SECRET, appId: '1', pem: PEM, fetchImpl: g.fetchImpl, log: () => {} }),
    (err) => /401/.test(err.message) && !err.message.includes(SECRET),
  );
});

test('the CLI runs when started through a symlinked path (macOS /tmp is /private/tmp), and says how to use it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'app-hook-'));
  try {
    const link = join(dir, 'tools');
    symlinkSync(fileURLToPath(new URL('../../gce/tools/', import.meta.url)), link);
    const run = spawnSync(process.execPath, [join(link, 'app-hook.mjs')], { encoding: 'utf8' });
    assert.equal(run.status, 2, run.stderr); // no URL given: usage, before any secret is read
    assert.match(run.stderr, /usage: node gce\/tools\/app-hook\.mjs <receiver url>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
