// The GCE ledger on GitHub (spec I12): the pool ledger issue, found by title, one comment per allocation. A tick
// reads only the comments updated in the last 26 h (a VM lives at most max_run_minutes, and the daily line needs
// yesterday), so the read stays small however long the issue grows. Writes keep that copy current. A row never
// moves back: before an update the comment is read again and the write is dropped if the comment is already as far
// along (a final row is never rewritten). Issue comments have no compare-and-swap, so during an overlap of two
// ticks a row is eventually final rather than finalized once: a stale writer whose update lands in the milliseconds
// after another finalized the row rolls it back to running, and the next tick finalizes it again, possibly with a
// later deletion time and charge. As with every overlap (spec Decision Log, 2026-10-16), correctness does not rest
// on a single writer, and the overlap heals itself.
// Two writers that each created a row for one allocation converge on the one every reader counts.
import { renderRow, parseRow, rowComments, rowsOf, moreFinal, renderDaily, dailyDays } from './ledger.mjs';

export const WINDOW_MS = 26 * 3600_000;

// `row` may replace `current` unless current is final or further along.
const mayWrite = (current, row) => current !== null && current.state !== 'final' && !moreFinal(current, row);

export function createGceLedger(gh, { repo, issue_title: title }, { now = Date.now } = {}) {
  let number = null;
  let comments = [];

  async function issue() {
    if (number !== null) return number;
    const found = (await gh.openIssues(repo)).find((i) => !i.pull_request && i.title === title);
    number = found
      ? found.number
      : (await gh.createIssue(repo, { title, body: 'One comment per ci-kit pool server session (spec I9) or GCE allocation (I12), and the cost summaries.' })).number;
    return number;
  }

  async function read() {
    comments = await gh.issueComments(repo, await issue(), { since: new Date(now() - WINDOW_MS).toISOString() });
    return comments;
  }

  return {
    read,
    rows: async () => rowsOf(comments),
    // Writes `row` over its allocation's comment unless that one is already further along; creates it if none.
    // `dedupe`: after creating, re-read and remove any other comment for the allocation (a concurrent writer's). A
    // launch row needs none: its allocation id was just made.
    async upsert(row, { dedupe = false } = {}) {
      const [counted, ...extras] = rowComments(comments, row.alloc).map((x) => x.c);
      const body = renderRow(row);
      if (!counted) {
        const made = await gh.createComment(repo, await issue(), body);
        comments.push(made ?? { id: Number.MAX_SAFE_INTEGER, body });
      } else if (mayWrite(parseRow(counted.body), row) && counted.body !== body) {
        const fresh = await gh.getComment(repo, counted.id);
        counted.body = fresh.body;
        if (mayWrite(parseRow(fresh.body), row) && fresh.body !== body) {
          await gh.updateComment(repo, counted.id, body);
          counted.body = body;
        }
      }
      if (extras.length || (!counted && dedupe)) {
        if (!counted) await read();
        for (const extra of rowComments(comments, row.alloc).slice(1).map((x) => x.c)) {
          await gh.deleteComment(repo, extra.id).catch((err) => {
            if (err.status !== 404) throw err; // the other writer removed it first
          });
          comments = comments.filter((c) => c.id !== extra.id);
        }
      }
    },
    // Posts the day's line unless one is already there. Returns whether it posted.
    async postDaily(line) {
      if (dailyDays(comments).has(line.day)) return false;
      const body = renderDaily(line);
      const made = await gh.createComment(repo, await issue(), body);
      comments.push(made ?? { id: Number.MAX_SAFE_INTEGER, body });
      return true;
    },
  };
}
