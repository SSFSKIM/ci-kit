// How the mac runner's hooks end the strays strays.mjs selected: SIGTERM, a grace, then SIGKILL for what is left.
// Tested with a scripted process table (test/mac-terminate.test.mjs).
//
// A pid is signalled only while the process holding it still has the identity it was selected with (uid and start
// time, strays.mjs's identityOf), checked against a fresh snapshot just before each round of signals: a stray that exited
// during the grace may have handed its pid to an unrelated process, which must get nothing. ESRCH means the stray is
// gone. Any other error (EPERM) is a failure, and so is a stray still holding its identity after SIGKILL: the sweep
// is then not ok, and says which pid, which signal and why.

/**
 * @param {{pid:number, identity:string}[]} strays
 * @param {{snapshot: () => Map<number,string>, signal: (pid:number, name:string) => void,
 *          sleep: (ms:number) => Promise<void>, graceMs?: number, pollMs?: number, settleMs?: number}} io
 *   snapshot: pid → identity of every process now; signal: process.kill, throwing with a `code`
 * @returns {Promise<{ok:boolean, events:{pid:number, signal:string, outcome:string, code?:string}[],
 *          failures:{pid:number, signal:string, code:string}[], survivors:number[]}>}
 *   events' outcomes: `sent`, `gone` (exited before the signal), `replaced` (its pid now another process's), `error`
 */
export async function terminate(strays, { snapshot, signal, sleep, graceMs = 10_000, pollMs = 250, settleMs = 2_000 }) {
  const events = [];
  const failures = [];
  const send = (stray, name, table) => {
    const holder = table.get(stray.pid);
    if (holder !== stray.identity) {
      events.push({ pid: stray.pid, signal: name, outcome: holder === undefined ? 'gone' : 'replaced' });
      return;
    }
    try {
      signal(stray.pid, name);
      events.push({ pid: stray.pid, signal: name, outcome: 'sent' });
    } catch (error) {
      if (error.code === 'ESRCH') {
        events.push({ pid: stray.pid, signal: name, outcome: 'gone' });
        return;
      }
      const code = error.code ?? String(error);
      failures.push({ pid: stray.pid, signal: name, code });
      events.push({ pid: stray.pid, signal: name, outcome: 'error', code });
    }
  };
  const ours = () => {
    const table = snapshot();
    return { table, pending: strays.filter((s) => table.get(s.pid) === s.identity) };
  };
  const awaitExit = async (limitMs) => {
    let { table, pending } = ours();
    for (let waited = 0; pending.length > 0 && waited < limitMs; waited += pollMs) {
      await sleep(pollMs);
      ({ table, pending } = ours());
    }
    return { table, pending };
  };

  let { table } = ours();
  for (const stray of strays) send(stray, 'SIGTERM', table);
  let pending;
  ({ table, pending } = await awaitExit(graceMs));
  if (pending.length > 0) {
    for (const stray of pending) send(stray, 'SIGKILL', table);
    ({ pending } = await awaitExit(settleMs));
  }
  return { ok: failures.length === 0 && pending.length === 0, events, failures, survivors: pending.map((s) => s.pid) };
}
