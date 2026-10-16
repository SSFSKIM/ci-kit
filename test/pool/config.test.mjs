// The pool config (spec I8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePoolConfig } from '../../pool/lib/config.mjs';

const shipped = readFileSync(new URL('../../pool/config/pool.json', import.meta.url), 'utf8');

test('the shipped pool.json is valid and serves no repo (MAWS moved to gce.json in M10 step 5; Hetzner is the frozen fallback)', () => {
  const cfg = parsePoolConfig(shipped);
  assert.deepEqual(cfg.repos, []);
  assert.deepEqual(cfg.types, ['cx53', 'cpx62']);
  assert.deepEqual(cfg.fallback_types, ['cpx52', 'cpx42']);
  assert.equal(cfg.ledger.issue_title, 'pool ledger');
});

test('a malformed config is refused with every problem named', () => {
  const bad = JSON.stringify({ ...JSON.parse(shipped), repos: [{ repo: 'nope', workflows: [] }], poll_seconds: 0, extra: 1 });
  assert.throws(() => parsePoolConfig(bad), (err) => {
    assert.match(err.message, /repos\[0\]\.repo/);
    assert.match(err.message, /repos\[0\]\.workflows/);
    assert.match(err.message, /poll_seconds/);
    assert.match(err.message, /unknown key "extra"/);
    return true;
  });
  assert.throws(() => parsePoolConfig('{'), /not JSON/);
});
