// Existing @v1 callers may still pass a cloud token. The action no longer provisions anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const token of ['', 'obsolete-token']) {
  test(`pool-ensure succeeds offline ${token ? 'with a legacy token' : 'without credentials'}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-kit-ensure-'));
    try {
      const output = join(dir, 'output');
      const entry = new URL('../../pool-ensure/ensure.mjs', import.meta.url).href;
      const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', `
        let requests = 0;
        globalThis.fetch = () => { requests++; throw new Error('no network allowed'); };
        await import(${JSON.stringify(entry)});
        if (requests) throw new Error('pool-ensure still makes network requests');
      `], { encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: 'SSFSKIM/MAWS', GITHUB_OUTPUT: output, HCLOUD_TOKEN: token } });
      assert.match(stdout, /no-op/);
      assert.equal(readFileSync(output, 'utf8'), 'result=none\n');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
