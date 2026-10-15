// Which processes the mac runner's job hooks kill: the pure half of sweep.mjs, tested against recorded `ps` and `lsof`
// shapes (test/mac-strays.test.mjs).
//
// A process is a stray when it belongs to the runner's user and either runs from the runner's work directory (a path
// under it in its command line: the job's Electron, its node from the tool cache, its vitest) or sits in it (its working
// directory is under it), and so is every descendant of a stray: an app's pty shell in /tmp is the app's. The sweep
// itself, its ancestors (the hook's shell, the runner's worker and listener) and its own children are never strays,
// though the hook runs inside the workspace.

/** Rows of `ps -axo pid=,ppid=,uid=,lstart=,command=`, run in the C locale (`lstart` is then `Thu Oct 15 22:02:31 2026`). */
export function parsePs(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(.*)$/.exec(line);
    if (match) {
      const [, pid, ppid, uid, started, command] = match;
      rows.push({ pid: Number(pid), ppid: Number(ppid), uid: Number(uid), started, command: command.trim() });
    }
  }
  return rows;
}

/**
 * A process's birth identity: its uid and start time. A pid alone can be reused once its process exits; the sweep
 * signals a pid only while it still has the identity it had when it was selected.
 */
export const identityOf = (p) => `${p.uid} ${p.started}`;

/** pid → working directory, from `lsof -a -d cwd -Fpn` (fields `p<pid>` then `n<path>`). */
export function parseLsofCwd(text) {
  const cwds = new Map();
  let pid = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== null) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

/**
 * @param {{processes: {pid:number, ppid:number, uid:number, started:string, command:string}[], cwds: Map<number,string>,
 *          workDir: string, uid: number, self: number}} input
 * @returns {{pid:number, identity:string, command:string, reason:string}[]} the strays, each with its identity and why:
 *   `command`, `cwd` or `child of <pid>`
 */
export function selectStrays({ processes, cwds, workDir, uid, self }) {
  const root = workDir.replace(/\/+$/, '');
  const under = (path) => path === root || (path ?? '').startsWith(`${root}/`);
  const names = (command) => command.includes(`${root}/`) || command.split(/\s+/).includes(root);

  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const children = new Map();
  for (const p of processes) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p]);

  const spared = new Set([self]);
  for (let p = byPid.get(self); p && !spared.has(p.ppid) && p.ppid > 0; p = byPid.get(p.ppid)) spared.add(p.ppid);
  const own = [self];
  while (own.length > 0) {
    for (const child of children.get(own.pop()) ?? []) {
      if (!spared.has(child.pid)) {
        spared.add(child.pid);
        own.push(child.pid);
      }
    }
  }

  const eligible = (p) => p.uid === uid && p.pid > 1 && !spared.has(p.pid);
  const strays = new Map();
  for (const p of processes) {
    if (!eligible(p)) continue;
    if (names(p.command)) strays.set(p.pid, { pid: p.pid, identity: identityOf(p), command: p.command, reason: 'command' });
    else if (under(cwds.get(p.pid))) strays.set(p.pid, { pid: p.pid, identity: identityOf(p), command: p.command, reason: 'cwd' });
  }
  const queue = [...strays.keys()];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const child of children.get(parent) ?? []) {
      if (!eligible(child) || strays.has(child.pid)) continue;
      strays.set(child.pid, { pid: child.pid, identity: identityOf(child), command: child.command, reason: `child of ${parent}` });
      queue.push(child.pid);
    }
  }
  return [...strays.values()];
}
