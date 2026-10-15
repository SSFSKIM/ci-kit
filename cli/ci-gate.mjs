// ci-gate (spec §2, I5): push the tested commit plus a nonce commit to a ci/ ref, follow the run it starts,
// print one line per gate as it finishes, keep failed gates' logs on local disk, and remove the ref.
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createGitHub, ghToken } from '../lib/github.mjs';
import { parseArgs, UsageError, USAGE } from './args.mjs';
import { deleteRef, nonceCommit, pushRef, resolveRemote, resolveTarget, TargetError } from './git.mjs';
import { cleanLog, nonceMessage, refName, sanitizeLabel } from './naming.mjs';
import { watchRun } from './watch.mjs';

const CALLER = '.github/workflows/ci.yml';
const FIND_RUN_MS = 2 * 60 * 1000;
const LOG_ATTEMPTS = 6; // a job's log can lag its completion by a few seconds

const out = (line) => process.stdout.write(line + '\n');
const note = (line) => process.stderr.write(`ci-gate: ${line}\n`);

async function findRun(gh, repo, commit) {
  const deadline = Date.now() + FIND_RUN_MS;
  while (Date.now() < deadline) {
    try {
      const runs = await gh.runsForCommit(repo, commit);
      const run = runs.find((r) => r.event === 'push' && r.path === CALLER);
      if (run) return run;
    } catch {
      // the next poll retries
    }
    await sleep(3000);
  }
  return null;
}

function failureSaver(gh, repo, runId, dir) {
  return async (job, gate) => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${gate}.log`);
    let log = null;
    for (let i = 0; i < LOG_ATTEMPTS && log === null; i += 1) {
      try {
        log = cleanLog(await gh.jobLog(repo, job.id));
      } catch {
        await sleep(5000);
      }
    }
    writeFileSync(path, log ?? `ci-gate: the log of this job could not be fetched; see ${job.html_url}\n`);
    try {
      const artifacts = await gh.runArtifacts(repo, runId);
      if (artifacts.some((a) => a.name === gate)) {
        execFileSync('gh', ['run', 'download', String(runId), '-R', repo, '-n', gate, '-D', join(dir, gate)], {
          stdio: 'ignore',
        });
      }
    } catch {
      note(`the artifacts of ${gate} could not be downloaded`);
    }
    return path;
  };
}

function planErrorReader(gh, repo) {
  return async (job) => {
    try {
      const notes = await gh.annotations(repo, job.id);
      const messages = notes
        .filter((a) => a.annotation_level === 'failure' && a.message.startsWith('ci-kit:'))
        .map((a) => a.message.trim());
      if (messages.length > 0) return messages.join('; ');
    } catch {
      // fall through to the job's URL
    }
    return `the plan job ended ${job.conclusion}: ${job.html_url}`;
  };
}

async function main(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(USAGE + '\n');
    out(`ERROR ${e.message}`);
    return 2;
  }

  const token = ghToken();
  if (!token) {
    out('ERROR gh is not authenticated (run: gh auth login)');
    return 2;
  }
  const gh = createGitHub(token);

  let target;
  let remote;
  try {
    target = resolveTarget(opts.target);
    remote = resolveRemote(target.dir, opts.repo);
  } catch (e) {
    if (!(e instanceof TargetError)) throw e;
    out(`ERROR ${e.message}`);
    return 2;
  }
  const { repo } = remote;
  if (target.dirty) note(`${target.dir} has uncommitted changes; they are not tested, only HEAD ${target.sha.slice(0, 8)}`);

  const nonce = randomBytes(6).toString('hex');
  const ref = refName(sanitizeLabel(opts.label ?? target.branch ?? 'gate'), target.sha, nonce);
  let commit;
  try {
    commit = nonceCommit(target.dir, target.sha, nonceMessage(nonce, opts.gates));
    note(`testing ${target.sha.slice(0, 8)} on ${repo} as ${ref}${opts.gates.length ? ` (CI-Gates: ${opts.gates.join(',')})` : ''}`);
    pushRef(target.dir, remote.name, commit, ref);
  } catch (e) {
    out(`ERROR push to ${repo} failed: ${String(e.stderr ?? e.message).trim().split('\n').at(-1)}`);
    return 2;
  }

  let runId = null;
  const cleanup = () => {
    if (opts.keep) return note(`kept ${ref}`);
    if (deleteRef(target.dir, remote.name, commit, ref)) note(`removed ${ref}`);
    else note(`left ${ref} (it no longer points at this call's commit, or the delete failed)`);
  };
  process.once('SIGINT', async () => {
    if (runId) await gh.cancelRun(repo, runId).then(() => note(`cancelled run ${runId}`), () => {});
    cleanup();
    out('ERROR interrupted');
    process.exit(130);
  });

  let result;
  try {
    result = await follow(gh, repo, commit, ref, (id) => { runId = id; });
  } catch (e) {
    result = failure(e);
  } finally {
    cleanup(); // also when following the run throws: the ref is this call's to remove
  }
  out(result.line);
  return result.code;
}

// An unexpected local failure (a log that cannot be written, say) still ends in I5's ERROR line and exit 2.
function failure(e) {
  return { line: `ERROR ci-gate failed: ${e?.message ?? e}`, code: 2 };
}

async function follow(gh, repo, commit, ref, onRun) {
  const run = await findRun(gh, repo, commit);
  if (!run) return { line: `ERROR no run of ${CALLER} appeared within 2 min of the push to ${ref}`, code: 2 };
  onRun(run.id);
  note(`run ${run.html_url}`);
  const [owner, name] = repo.split('/');
  return watchRun({
    gh,
    repo,
    runId: run.id,
    runUrl: run.html_url,
    emit: out,
    onFail: failureSaver(gh, repo, run.id, join('/tmp/ci-gate', `${owner}-${name}`, String(run.id))),
    planError: planErrorReader(gh, repo),
    now: Date.now,
    sleep,
  });
}

process.exitCode = await main(process.argv.slice(2)).catch((e) => {
  const { line, code } = failure(e);
  out(line);
  return code;
});
