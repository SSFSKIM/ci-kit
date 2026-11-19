// The gate ledger's job lines (gate ledger spec, "A job line" and Glossary "Gate attempt"): pure functions over a
// run, its attempt's jobs and the repository's entry in history/repos.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { platformKind } from '../../history/jobs.mjs';

test('platform messages are named by kind, and nothing else is', () => {
  assert.equal(platformKind('The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the \'Billing & plans\' section in your settings'), 'not-started');
  assert.equal(platformKind('The self-hosted runner: ci-kit-gce-a1 lost communication with the server. Verify the machine is running and has a healthy network connection.'), 'runner-lost');
  assert.equal(platformKind('The runner has received a shutdown signal. This can happen when the runner service is stopped, or a manually started runner is canceled.'), 'runner-lost');
  assert.equal(platformKind('The job running on runner ci-kit-gce-a1 has exceeded the maximum execution time of 30 minutes.'), 'time-limit');
  assert.equal(platformKind('Process completed with exit code 1.'), null);
  assert.equal(platformKind('expected 2 to equal 3'), null);
  assert.equal(platformKind(undefined), null);
});
