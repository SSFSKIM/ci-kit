// One Mac's desktop for the dialog hooks' tests: its own HOME, with the job hook (desktop-check.sh) and the dialog
// watcher (dialog-watch.sh) run against it. Every boundary is faked: the frontmost app (lsappinfo), the windows on
// screen (window-list), Terminal (open), the unified log, gh, the clock (date), launchd (launchctl) and the runner's
// processes (python3, standing in for runner-state.py, whose own test reads real processes).
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hooks = fileURLToPath(new URL('../mac/hooks/', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'ci-kit-desktop-'));
process.on('exit', () => rmSync(root, { recursive: true, force: true }));

export const runnerAgent = 'com.ssfskim.ci-kit.mac-runner';
// The clock every desktop starts at, in seconds; runs move it forward a minute each unless told `at`.
export const T0 = Date.parse('2026-10-17T05:12:34Z') / 1000;
export const iso = (seconds) => new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
export const minute = (seconds) => iso(seconds).replace(/:\d\dZ$/, 'Z');

// The two shapes lsappinfo prints for `info -only name`: macOS 27 over ssh, and the LSDisplayName pair.
// With a bundle id, each also prints it: `bundleID="<id>"` and `"CFBundleIdentifier"="<id>"` (both checked live).
export const asnShape = (name, bundle, pid) =>
  `"${name}" ASN:0x0-0x48b78b3: (in front) \n    bundleID=${bundle ? `"${bundle}"` : '[ NULL ]'} \n    bundle path=[ NULL ] \n${pid === undefined ? '' : `    pid = ${pid} (0xb84f)\n`}`;
export const pairShape = (name, bundle, pid) => `"LSDisplayName"="${name}"\n${bundle ? `"CFBundleIdentifier"="${bundle}"\n` : ''}${pid === undefined ? '' : `"pid"=${pid}\n`}`;
export const terminal = asnShape('터미널', 'com.apple.Terminal');

// One line of window-list (mac/hooks/window-list.swift): owner pid, layer, alpha, x, y, width, height, bundle id ('-'
// for none) and owner name, tab-separated, front to back.
export const windowLine = ({ pid, layer = 0, alpha = '1.0', x = 1000, y = 400, width = 520, height = 260, bundle = '-', name }) =>
  [pid, layer, alpha, x, y, width, height, bundle, name].join('\t');
// An ordinary desktop, as the mini's read on 2026-10-21 (macOS 27): the menu bar, the Dock and Terminal, nothing else.
export const ordinaryWindows = [
  windowLine({ pid: 179, layer: 24, x: 0, y: 0, width: 2560, height: 30, name: 'Window Server' }),
  windowLine({ pid: 457, layer: 20, x: 0, y: 0, width: 2560, height: 1440, bundle: 'com.apple.dock', name: 'Dock' }),
  windowLine({ pid: 431, x: 1400, y: 280, width: 580, height: 408, bundle: 'com.apple.Terminal', name: '터미널' }),
].join('\n') + '\n';
// The same desktop with a dialog's window over it, topmost.
export const withWindow = (window) => `${windowLine(window)}\n${ordinaryWindows}`;

const executable = (path, body) => { writeFileSync(path, `#!/bin/bash\n${body}\n`); chmodSync(path, 0o755); };
// A fake that hangs ignoring SIGALRM, recording its pid so a run can tell whether the deadline killed it.
const hangs = (dir) => `trap '' ALRM\necho "$$" >> '${join(dir, 'hung-pids.txt')}'\nexec /bin/sleep 60`;

// runner: what runner-state.py reports (idle, with or without its listener-log mark, busy, stopped), or a failure of it
// (fail, garbage, hang); one line per read, the last line standing for every read after it. `launchctl kill SIGTERM`
// stops an idle runner, as runsvc.sh's trap does: it reads stopped afterwards. The drain's second idle read follows the
// first at once (CI_KIT_IDLE_GAP=0) unless a run says otherwise.
// windows and windowList: what window-list prints and how it ends (below) at each run unless the run says otherwise.
export function desktop({ status = 0, afterOpen, openStatus = 0, logOutput = '', logStatus = 0, logResponses = {}, now, ghStatus = 0, logHang = false, ghHang = false, env = {}, alertToken, runner = 'idle', windows: desktopWindows = ordinaryWindows, windowList: desktopListEnd = 0 } = {}) {
  const dir = join(root, String(Math.random()).slice(2));
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const file = (name) => join(dir, name);
  const text = (name) => existsSync(file(name)) ? readFileSync(file(name), 'utf8') : '';
  if (alertToken !== undefined) {
    mkdirSync(file('.config/ci-kit'), { recursive: true });
    writeFileSync(file('.config/ci-kit/alert-token'), alertToken);
  }
  const front = file('out.txt');
  if (afterOpen !== undefined) writeFileSync(file('after.txt'), afterOpen);
  executable(join(bin, 'lsappinfo'), `[[ \${FAKE_FRONT_HANG:-0} == 1 ]] && { ${hangs(dir).replace(/\n/g, '; ')}; }
if [[ $1 == front ]]; then echo 'ASN:0x0-0x48b78b3:'; exit 0; fi
cat '${front}'
exit ${status}`);
  // window-list prints windows.txt and exits with windows-status, or hangs; a run that names it missing points the hooks
  // at a path with nothing there.
  const windowList = join(bin, 'window-list');
  executable(windowList, `echo read >> '${file('window-list.calls')}'
[[ $(cat '${file('windows-status')}') == hang ]] && { ${hangs(dir).replace(/\n/g, '; ')}; }
cat '${file('windows.txt')}'
exit $(cat '${file('windows-status')}')`);
  executable(join(bin, 'open'), `echo "$*" >> '${file('opened.txt')}'
[[ -f '${file('after.txt')}' ]] && cp '${file('after.txt')}' '${front}'
exit ${openStatus}`);
  const log = join(bin, 'unified-log');
  for (const kind of ['firewall', 'front', 'requests', 'other']) {
    const { output = logOutput, status = logStatus, hang = logHang } = logResponses[kind] ?? {};
    writeFileSync(file(`${kind}.txt`), output);
    writeFileSync(file(`${kind}.sh`), `${hang ? 'exec /bin/sleep 60' : ''}\ncat '${file(`${kind}.txt`)}'\nexit ${status}\n`);
  }
  executable(log, `printf '%s\\0' "$@" >> '${file('log-args.txt')}'
printf '\\0' >> '${file('log-args.txt')}'
case "$*" in
  *'process == "socketfilterfw"'*) kind=firewall ;;
  *'TCCAccessRequest'*) kind=requests ;;
  *'process == "launchservicesd"'*) kind=front ;;
  *) kind=other ;;
esac
source '${dir}/'"$kind".sh`);
  // The clock: `date -u +%s` and every other +format read one file of epoch seconds.
  const clock = file('clock');
  writeFileSync(clock, String(now ? Date.parse(now) / 1000 : T0));
  executable(join(bin, 'date'), `t=$(cat '${clock}')
for a; do
  case $a in
    +%s) echo "$t"; exit 0 ;;
    +*) exec perl -MPOSIX=strftime -e 'print strftime(substr($ARGV[0], 1), gmtime $ARGV[1]), "\\n"' "$a" "$t" ;;
  esac
done
exec /bin/date "$@"`);
  const gh = join(bin, 'gh');
  executable(gh, `printf '%s\\0' "$@" >> '${file('gh-args.txt')}'
printf '\\0' >> '${file('gh-args.txt')}'
printf '%s\\n' "\${GH_TOKEN-<unset>}" >> '${file('gh-tokens.txt')}'
if [[ $FAKE_GH_HANG == 1 ]]; then
  ${hangs(dir).replace(/\n/g, '\n  ')}
fi
[[ $FAKE_GH_STATUS == 0 ]] || exit "$FAKE_GH_STATUS"
[[ " $FAKE_GH_FAIL " != *" $2 "* ]] || exit 1
if [[ $FAKE_GH_UNRESOLVED == 1 && ($2 == comment || $2 == close) ]]; then
  echo "GraphQL: Could not resolve to an issue or pull request with the number of \${3##*/}. (repository.issue)" >&2
  exit 1
fi
if [[ $1 == api ]]; then
  case $2 in
    repos/*/issues/*)
      case $FAKE_GH_ISSUE in
        open | closed) echo "$FAKE_GH_ISSUE" ;;
        hang)
          ${hangs(dir).replace(/\n/g, '\n          ')}
          ;;
        *) echo '{"status":"'"$FAKE_GH_ISSUE"'"}'; echo "gh: Not Found (HTTP $FAKE_GH_ISSUE)" >&2; exit 1 ;;
      esac
      ;;
    *) [[ $FAKE_GH_REPO == 1 ]] || { echo 'gh: Not Found (HTTP 404)' >&2; exit 1; } ;;
  esac
fi
if [[ $1 == issue && $2 == create ]]; then echo https://github.com/SSFSKIM/ci-kit-sandbox/issues/42; fi`);
  const processes = file('runner');
  writeFileSync(processes, runner);
  // A shared instance n's runner (desktop.instance) reads from runner-actions-runner-maws-<n>, stopped through its agent.
  executable(join(bin, 'launchctl'), `printf '%s\\n' "$*" >> '${file('launchctl.calls')}'
[[ $1 == "\${FAKE_LAUNCHCTL_HANG:-}" ]] && { ${hangs(dir).replace(/\n/g, '; ')}; }
states='${processes}'
[[ \${3:-} == *-[0-9]* ]] && states='${processes}'-actions-runner-maws-\${3##*-}
case $1 in
  kill) [[ $(head -1 "$states") != idle* ]] || echo stopped >"$states" ;;
  *) exit 64 ;;
esac`);
  executable(join(bin, 'python3'), `printf '%s\\n' "$*" >> '${file('python.calls')}'
states='${processes}'
[[ -f '${processes}'-\${3##*/} ]] && states='${processes}'-\${3##*/}
state=$(head -1 "$states")
if (($(grep -c '' "$states") > 1)); then tail -n +2 "$states" >"$states.next"; mv "$states.next" "$states"; fi
case $state in
  idle*) echo "$state" ;;
  busy) echo 'busy 4242' ;;
  stopped) echo stopped ;;
  fail) exit 2 ;;
  garbage) echo 'Traceback (most recent call last):'; exit 1 ;;
  hang) ${hangs(dir).replace(/\n/g, '; ')} ;;
esac`);

  let last = null;
  // A run's gh: every call exits ghExit, and the issue subcommands named in ghFail (`'close'`, `'comment close'`) exit 1.
  // ghUnresolved fails comment and close as gh does for an issue GitHub will not resolve: one that does not exist, or one
  // the caller cannot see. `gh api repos/…/issues/<n>` answers ghIssue: its state (open, closed), an HTTP status it
  // fails with (404, 410), or hang. `gh api repos/<repo>` goes through unless ghRepo is false. windows is what
  // window-list prints; windowList is how it ends: 0, another exit status, 'hang' or 'missing'.
  function run(script, output, { at, ghExit = ghStatus, ghFail = '', ghUnresolved = false, ghIssue = 'open', ghRepo = true, ghStall = ghHang, args = [], extraEnv = {}, windows = desktopWindows, windowList: listEnd = desktopListEnd } = {}) {
    last = at === undefined ? (last === null ? 0 : last + 60) : at;
    writeFileSync(clock, String((now ? Date.parse(now) / 1000 : T0) + last));
    writeFileSync(front, output);
    writeFileSync(file('windows.txt'), windows);
    writeFileSync(file('windows-status'), String(listEnd === 'missing' ? 0 : listEnd));
    writeFileSync(file('hung-pids.txt'), '');
    const job = script === 'desktop-check.sh' ? { GITHUB_RUN_ID: '123456', GITHUB_JOB: 'e2e' } : {};
    const started = Date.now();
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', join(hooks, script), ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        PATH: `${bin}:/usr/bin:/bin`, HOME: dir,
        CI_KIT_LOG_BIN: log, CI_KIT_GH_BIN: gh, CI_KIT_WINDOW_LIST: listEnd === 'missing' ? join(bin, 'no-window-list') : windowList, FAKE_GH_STATUS: String(ghExit), FAKE_GH_FAIL: ghFail, FAKE_GH_UNRESOLVED: ghUnresolved ? '1' : '0', FAKE_GH_ISSUE: ghIssue, FAKE_GH_REPO: ghRepo ? '1' : '0', FAKE_GH_HANG: ghStall ? '1' : '0',
        CI_KIT_IDLE_GAP: '0', ...job, ...env, ...extraEnv,
      },
    });
    const elapsed = Date.now() - started;
    const survivors = [];
    for (const pid of text('hung-pids.txt').trim().split('\n').filter(Boolean).map(Number)) {
      try {
        process.kill(pid, 0);
        survivors.push(pid);
        process.kill(pid, 'SIGKILL'); // Do not leak a stalled fake if a deadline regresses.
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    const stateText = existsSync(file('Library/Logs/ci-kit/dialog-alert.state')) ? text('Library/Logs/ci-kit/dialog-alert.state') : null;
    const marker = existsSync(file('Library/Logs/ci-kit/runner-drained')) ? text('Library/Logs/ci-kit/runner-drained') : null;
    return {
      ...result,
      elapsed,
      ghSurvivors: survivors,
      windowReads: text('window-list.calls').split('\n').filter((line) => line !== '').length,
      log: text('Library/Logs/ci-kit/mac-runner-hooks.log'),
      opened: text('opened.txt').trim().split('\n').filter(Boolean),
      ghCalls: text('gh-args.txt').split('\0\0').filter(Boolean).map((call) => call.split('\0')),
      ghTokens: text('gh-tokens.txt').split('\n').filter(Boolean),
      logArgs: text('log-args.txt').split('\0').filter(Boolean),
      logCalls: text('log-args.txt').split('\0\0').filter(Boolean).map((call) => call.split('\0')),
      stateText,
      state: stateText === null ? null : Object.fromEntries(stateText.trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])),
      marker,
      launchctl: text('launchctl.calls').trim().split('\n').filter(Boolean),
      runner: text('runner').trim(),
      python: text('python.calls').trim().split('\n').filter(Boolean),
      again: (next, options) => run('desktop-check.sh', next, options),
      watch: (next, options) => run('dialog-watch.sh', next, options),
      desktop: api,
    };
  }
  const api = {
    dir,
    hook: (output, options) => run('desktop-check.sh', output, options),
    watch: (output, options) => run('dialog-watch.sh', output, options),
    runner: (state) => writeFileSync(processes, state),
    // A shared instance, ~/actions-runner-maws-<n>, whose runner reads as state does.
    instance: (n, state) => { mkdirSync(file(`actions-runner-maws-${n}`), { recursive: true }); writeFileSync(`${processes}-actions-runner-maws-${n}`, state); },
    // Holds the dialog state's lock, as a hook mid-alert would, until the returned function is called; it returns once
    // the lock is free again.
    holdLock() {
      mkdirSync(file('Library/Logs/ci-kit'), { recursive: true });
      const release = file('release-lock');
      const holder = spawnSync('bash', ['-c', `perl -MFcntl=:flock -e '
        open(my $fh, ">>", shift) or die; flock($fh, LOCK_EX) or die;
        if (fork) { exit 0 } open(STDOUT, ">/dev/null"); open(STDERR, ">/dev/null");
        select(undef, undef, undef, 0.05) until -e $ARGV[0]; unlink $ARGV[0];' '${file('Library/Logs/ci-kit/dialog-alert.lock')}' '${release}'`], { encoding: 'utf8' });
      if (holder.status !== 0) throw new Error(holder.stderr);
      return () => {
        writeFileSync(release, '');
        const free = spawnSync('perl', ['-MFcntl=:flock', '-e', 'open(my $fh, ">>", shift) or die; alarm 10; flock($fh, LOCK_EX) or die',
          file('Library/Logs/ci-kit/dialog-alert.lock')], { encoding: 'utf8' });
        if (free.status !== 0) throw new Error(`the lock was not released: ${free.stderr}`);
      };
    },
  };
  return api;
}

// The job hook's tests start a desktop with its first job.
export function check(output, status = 0, { readOnly = false, ...options } = {}) {
  return desktop({ status, ...options }).hook(output, readOnly ? { args: ['--frontmost'] } : {});
}
