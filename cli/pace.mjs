// The pace of ci-gate's polls against the GitHub token every session on the account shares (spec Decision Log,
// "ci-gate is a good citizen of the shared token"). One pacer serves a whole call, discovery and watch alike, so the
// THROTTLE line is said once.

export const THROTTLE_BELOW = 500;
export const THROTTLED_MS = 60_000;

export const isLow = (remaining) => remaining !== null && remaining < THROTTLE_BELOW;

//   gh.stats() → { remaining }: the client's view of the budget (null until a response reports it).
//   emit(line): one stdout line.
export function createPacer(gh, emit) {
  let said = false;
  return {
    // The wait before the next poll: `baseMs` while the budget is healthy, THROTTLED_MS while it is low.
    wait(baseMs) {
      const { remaining } = gh.stats();
      if (!isLow(remaining)) return baseMs;
      if (!said) {
        said = true;
        emit(`THROTTLE remaining=${remaining}`);
      }
      return THROTTLED_MS;
    },
  };
}
