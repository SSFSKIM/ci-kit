// Call spans on the existing structured `tick:` line, not extra tick log entries. `started` + `ms` locates each
// call beside the tick's start and firstInsert, including overlapping reads: durations must not be added together.
// A call still in flight when the tick is logged has ms: null; failures retain their duration and rejection.
export function createPreparation({ now = Date.now } = {}) {
  const calls = [];
  return {
    calls,
    async time(call, run, fields = {}) {
      const began = now();
      const entry = { call, ...fields, started: new Date(began).toISOString(), ms: null };
      calls.push(entry);
      try {
        return await run();
      } catch (err) {
        entry.failed = true;
        throw err;
      } finally {
        entry.ms = now() - began;
      }
    },
  };
}
