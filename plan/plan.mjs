#!/usr/bin/env node
// The planner (spec I3): reads the caller's .github/ci-kit.yml and decides which gates run where.
// Inputs come from the environment, set by gates.yml; it runs in the caller's checkout (the changed files come from git).
// Success: the plan as JSON on stdout. A config error: `ci-kit: <message>` lines on stderr, exit 2.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ConfigError, EVENTS, parseConfig } from './config.mjs';
import { planOutput, selectGates, splitList, trailerGates } from './select.mjs';

// Added, modified, deleted, and both paths of a rename (--no-renames reports a rename as a delete plus an add),
// counted from the merge-base of base and head.
function changedFiles(base, head) {
  let out;
  try {
    out = execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', `${base}...${head}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const why = String(e.stderr ?? '').trim().split('\n')[0];
    throw new ConfigError([`cannot list the files changed between ${base} and ${head}: ${why}`]);
  }
  return out.split('\0').filter(Boolean);
}

// The events a gate's `on` names, and the build cache's seeding runs, which select by build_cache: a schedule, and a
// push to the default branch.
const PLANNED = [...EVENTS, 'schedule', 'push'];

function plan(env) {
  let event = env.CI_KIT_EVENT;
  if (!PLANNED.includes(event)) {
    throw new ConfigError([`CI_KIT_EVENT must be pr, ci-ref, dispatch, schedule or push, not "${event ?? ''}"`]);
  }
  // A push with no base (gates.yml leaves it empty for a new branch or a force push) has no change to select by: it
  // seeds every build_cache gate, as a schedule does.
  if (event === 'push' && !env.CI_KIT_BASE) event = 'schedule';
  const configPath = env.CI_KIT_CONFIG || '.github/ci-kit.yml';

  let text;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch {
    throw new ConfigError([`no config at ${configPath}`]);
  }
  const config = parseConfig(text, { isPrivate: env.CI_KIT_PRIVATE === 'true' });

  let explicit = null;
  let explicitSource;
  if (event === 'dispatch') {
    explicit = splitList(env.CI_KIT_GATES ?? '');
    explicitSource = 'the gates input';
  } else if (event === 'ci-ref') {
    explicit = trailerGates(env.CI_KIT_HEAD_MESSAGE);
    explicitSource = 'CI-Gates';
  }

  let changed = [];
  const needsChanges = event !== 'dispatch' && event !== 'schedule' && !(explicit && explicit.length > 0);
  if (needsChanges) {
    if (!env.CI_KIT_BASE || !env.CI_KIT_HEAD) {
      throw new ConfigError([`CI_KIT_BASE and CI_KIT_HEAD are required for event ${event}`]);
    }
    changed = changedFiles(env.CI_KIT_BASE, env.CI_KIT_HEAD);
  }

  // The build cache is written on the default branch only: every run reads that branch's entries, while what another
  // ref writes is read by nothing but that ref's own later runs.
  const cacheWrite = Boolean(env.CI_KIT_DEFAULT_BRANCH) && env.CI_KIT_REF === `refs/heads/${env.CI_KIT_DEFAULT_BRANCH}`;
  const selected = selectGates(config, { event, explicit, explicitSource, changedFiles: changed });
  return planOutput(config, selected, { cacheWrite });
}

try {
  process.stdout.write(JSON.stringify(plan(process.env)) + '\n');
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  for (const m of e.messages) process.stderr.write(`ci-kit: ${m}\n`);
  process.exitCode = 2;
}
