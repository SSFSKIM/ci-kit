// The janitor's report: worktrees that could go, VMs that have run long, and where the memory is. It reads; it
// never deletes anything.
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const GIT_TIMEOUT_MS = 60_000;

// --no-optional-locks: git status would otherwise refresh and rewrite the index of a worktree an agent is using.
const git = (dir, args) =>
  execFileSync('git', ['--no-optional-locks', '-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GIT_TIMEOUT_MS,
  });

export function parseWorktrees(porcelain) {
  const worktrees = [];
  for (const block of porcelain.split('\n\n')) {
    const lines = block.split('\n').filter(Boolean);
    if (!lines[0]?.startsWith('worktree ')) continue;
    const field = (name) => lines.find((l) => l === name || l.startsWith(`${name} `));
    const branch = field('branch')?.slice('branch refs/heads/'.length) ?? null;
    worktrees.push({
      path: lines[0].slice('worktree '.length),
      branch,
      main: worktrees.length === 0,
      prunable: field('prunable') !== undefined,
      locked: field('locked') !== undefined,
    });
  }
  return worktrees;
}

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// The repos under root that have linked worktrees: a .git directory (a linked worktree has a .git file) with
// entries under .git/worktrees. Checked on disk, so a repo without worktrees costs no git call.
function reposWithWorktrees(root) {
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names
    .map((name) => join(root, name))
    .filter((dir) => isDir(join(dir, '.git')) && isDir(join(dir, '.git', 'worktrees')) && readdirSync(join(dir, '.git', 'worktrees')).length > 0);
}

// The default branch to judge "merged" against: origin's HEAD when the repo has one, else a local main or master.
function defaultBranch(repo) {
  const refs = git(repo, ['for-each-ref', '--format=%(refname) %(symref:short)', 'refs/remotes/origin/HEAD', 'refs/heads/main', 'refs/heads/master'])
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split(' '));
  const origin = refs.find(([ref, target]) => ref === 'refs/remotes/origin/HEAD' && target);
  if (origin) return origin[1];
  return ['main', 'master'].find((b) => refs.some(([ref]) => ref === `refs/heads/${b}`)) ?? null;
}

// Per repo: its default branch, worktree list and merged branches (three git calls), then a status call for
// each linked worktree whose branch is merged.
export function scanWorktrees(root) {
  const reclaimable = [];
  const prunable = [];
  const errors = [];
  for (const repo of reposWithWorktrees(root)) {
    try {
      const into = defaultBranch(repo);
      if (!into) {
        errors.push(`${repo}: no origin/HEAD, main or master to judge merges against`);
        continue;
      }
      const linked = parseWorktrees(git(repo, ['worktree', 'list', '--porcelain'])).filter((w) => !w.main);
      prunable.push(...linked.filter((w) => w.prunable));
      // Branch name → when its tip was committed: a worktree made moments ago shows as merged until its first commit.
      const merged = new Map(
        git(repo, ['branch', '--merged', into, '--format=%(refname:short)%09%(committerdate:format:%Y-%m-%d %H:%M)'])
          .split('\n')
          .filter(Boolean)
          .map((l) => l.split('\t')),
      );
      const defaultName = into.replace(/^origin\//, '');
      for (const w of linked) {
        if (w.prunable || w.locked || !w.branch || w.branch === defaultName || !merged.has(w.branch)) continue;
        try {
          if (git(w.path, ['status', '--porcelain']).trim() === '') reclaimable.push({ path: w.path, branch: w.branch, mergedInto: into, committed: merged.get(w.branch) });
        } catch (err) {
          errors.push(`${w.path}: git status failed (${firstLine(err)})`);
        }
      }
    } catch (err) {
      errors.push(`${repo}: ${firstLine(err)}`);
    }
  }
  return { reclaimable, prunable, errors };
}

const firstLine = (err) => String(err.stderr || err.message).trim().split('\n')[0];

// `tart list --format json` names the running VMs; each one's age is that of its `tart run <name>` process.
export function runningVms(tartListJson, procs) {
  const running = JSON.parse(tartListJson).filter((vm) => vm.Running === true || vm.State === 'running');
  return running.map(({ Name: name }) => {
    const proc = procs.find((p) => {
      const [exe, sub, ...args] = p.command.split(/\s+/);
      return basename(exe) === 'tart' && sub === 'run' && args.includes(name);
    });
    return { name, age: proc ? proc.age : null };
  });
}

// The app bundle a process belongs to (its helpers fold into it), else its executable's name.
export function categoryOf(command) {
  const app = /\/([^/]+)\.app\//.exec(command);
  if (app) return app[1];
  return basename(command.split(/\s+/)[0]);
}

export function memoryByCategory(procs, top = 10) {
  const byCategory = new Map();
  for (const p of procs) {
    const c = categoryOf(p.command);
    const entry = byCategory.get(c) ?? { category: c, count: 0, rssKb: 0 };
    entry.count += 1;
    entry.rssKb += p.rss;
    byCategory.set(c, entry);
  }
  return [...byCategory.values()].sort((a, b) => b.rssKb - a.rssKb).slice(0, top);
}

export const formatAge = (seconds) => `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;

const formatRss = (kb) => (kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`);

// A command line in a table cell: one line, no pipes, bounded.
const cell = (text, max = 200) => {
  const flat = text.replace(/\|/g, '\\|').replace(/`/g, "'");
  return `\`${flat.length > max ? `${flat.slice(0, max)}…` : flat}\``;
};

function table(header, rows) {
  if (rows.length === 0) return 'None.\n';
  return [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n') + '\n';
}

export function renderReport({ host, at, dryRun, minAgeHours, vmReportHours, killed, spared, worktrees, vms, memory }) {
  const out = [];
  out.push(`# ci-kit host report: ${host}`, '');
  out.push(`Written ${at} by \`host/janitor.mjs\`${dryRun ? ' in dry-run mode' : ''}. Rewritten every run.`);
  out.push('The janitor kills only orphaned one-shot test processes. It deletes nothing listed here: removing a');
  out.push("worktree or a VM is a person's call, or a session's.", '');

  out.push(`## Orphaned test processes (parent launchd, older than ${minAgeHours} h)`, '');
  out.push(dryRun ? '### Would kill (dry run)' : '### Killed', '');
  out.push(table(['pid', 'age', 'pattern', 'result', 'command'], killed.map((k) => [k.pid, formatAge(k.age), cell(k.pattern, 80), k.result, cell(k.command)])));
  out.push('### Left running (long-lived modes, matched by an exclusion)', '');
  out.push(table(['pid', 'age', 'excluded by', 'command'], spared.map((s) => [s.pid, formatAge(s.age), cell(s.excludedBy, 80), cell(s.command)])));

  out.push('## Worktrees clean and merged into their default branch', '');
  out.push('A worktree made moments ago is listed too, until its first commit: the tip date tells them apart.', '');
  out.push(table(['worktree', 'branch', 'merged into', 'tip committed'], worktrees.reclaimable.map((w) => [cell(w.path), w.branch, w.mergedInto, w.committed])));
  if (worktrees.prunable.length) {
    out.push('Registered worktrees whose directory is gone (`git worktree prune` in their repo):', '');
    out.push(...worktrees.prunable.map((w) => `- ${cell(w.path)}`), '');
  }
  if (worktrees.errors.length) {
    out.push('Not scanned:', '');
    out.push(...worktrees.errors.map((e) => `- ${e}`), '');
  }

  out.push(`## VMs running more than ${vmReportHours} h`, '');
  if (vms === null) out.push('`tart` is not installed.', '');
  else if (typeof vms === 'string') out.push(vms, '');
  else out.push(table(['VM', 'running for'], vms.map((v) => [v.name, v.age === null ? 'unknown' : formatAge(v.age)])));

  out.push('## Top memory users by category', '');
  out.push('Resident memory summed per app or executable, every user. Shared pages count once per process, so the');
  out.push('figures overstate; they rank, they do not add up.', '');
  out.push(table(['category', 'processes', 'resident'], memory.map((m) => [m.category, m.count, formatRss(m.rssKb)])));
  return out.join('\n');
}
