// The GCE ledger on GitHub (spec I12): one comment per allocation on the current ledger issue, plus the daily lines.
// A tick reads only the comments updated in the last 26 h (a VM lives at most max_run_minutes, and the daily line needs
// yesterday), so the read stays small however long an issue grows. Writes keep that copy current. A row never
// moves back: before an update the comment is read again and the write is dropped if the comment is already as far
// along (a final row is never rewritten). Issue comments have no compare-and-swap, so during an overlap of two
// ticks a row is eventually final rather than finalized once: a stale writer whose update lands in the milliseconds
// after another finalized the row rolls it back to running, and the next tick finalizes it again, possibly with a
// later deletion time and charge. As with every overlap (spec Decision Log, 2026-10-16), correctness does not rest
// on a single writer, and the overlap heals itself.
// Two writers that each created a row for one allocation converge on the one every reader counts.
//
// Rotation (ci-kit#25): GitHub accepts no new comment on an issue that has 2,500. The ledger is every open issue
// titled `issue_title` or `issue_title from <day>`; the newest (highest number) is current and takes new comments,
// and every one of them is read over the window, so a row stays in view wherever its comment lives and is updated
// there by its id. A read that finds the current issue at ROTATE_AT comments opens the next one. Two ticks that
// both do so open two; every reader then takes the newer as current, and the rows either wrote stay in view because
// both issues are read. An older issue is closed once nothing on it was updated inside the window and the issue
// after it is a window old (a tick that listed before that one existed may still be writing to it).
import { renderRow, parseRow, rowComments, rowsOf, moreFinal, renderDaily, dailyDays } from './ledger.mjs';

export const WINDOW_MS = 26 * 3600_000;
// 500 below the cap: about two days at MAWS's rate, for a rotation that keeps failing, a count GitHub reports late,
// and the comments a tick already under way adds. An issue left behind therefore never reaches the cap.
export const ROTATE_AT = 2000;

// `row` may replace `current` unless current is final or further along.
const mayWrite = (current, row) => current !== null && current.state !== 'final' && !moreFinal(current, row);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function createGceLedger(gh, { repo, issue_title: title }, { now = Date.now, log = () => {} } = {}) {
  const ledgerTitle = new RegExp(`^${escape(title)}( from \\d{4}-\\d{2}-\\d{2})?$`);
  let issues = []; // the open ledger issues, oldest first: the last is current
  let comments = [];

  async function open(previous) {
    const made = await gh.createIssue(repo, {
      title: `${title} from ${new Date(now()).toISOString().slice(0, 10)}`,
      body: 'The GCE pool ledger (ci-kit spec I12): one comment per GCE allocation, and the daily cost lines' +
        `${previous ? `, continuing #${previous}` : ''}. The launcher starts the next issue at ${ROTATE_AT} comments, ` +
        'below GitHub\'s cap of 2,500, and closes this one once nothing on it is inside its 26 h window.',
    });
    return { number: made.number, comments: 0, created_at: made.created_at ?? new Date(now()).toISOString() };
  }

  async function readComments() {
    const since = new Date(now() - WINDOW_MS).toISOString();
    const per = await Promise.all(issues.map((i) => gh.issueComments(repo, i.number, { since })));
    comments = per.flat();
    return per;
  }

  async function read() {
    issues = (await gh.openIssues(repo))
      .filter((i) => !i.pull_request && ledgerTitle.test(i.title))
      .sort((a, b) => a.number - b.number);
    const current = issues.at(-1);
    if (!current) {
      issues.push(await open(null));
    } else if (current.comments >= ROTATE_AT) {
      try {
        issues.push(await open(current.number));
        log(`ledger: #${current.number} has ${current.comments} comments; new rows go on #${issues.at(-1).number}`);
      } catch (err) {
        log(`ledger: the issue after #${current.number} could not be opened (${err.message}); rows stay on #${current.number}`);
      }
    }
    const per = await readComments();
    const cutoff = now() - WINDOW_MS;
    const retired = new Set();
    for (let k = 0; k < issues.length - 1; k += 1) {
      if (per[k].length || Date.parse(issues[k + 1].created_at) > cutoff) continue;
      try {
        await gh.closeIssue(repo, issues[k].number);
        retired.add(issues[k].number);
        log(`ledger: closed #${issues[k].number}; nothing on it is inside the window`);
      } catch (err) {
        log(`ledger: closing #${issues[k].number}: ${err.message}`);
      }
    }
    issues = issues.filter((i) => !retired.has(i.number));
    return comments;
  }

  async function current() {
    if (!issues.length) await read();
    return issues.at(-1).number;
  }

  return {
    read,
    rows: async () => rowsOf(comments),
    // Writes `row` over its allocation's comment unless that one is already further along; creates it if none.
    // `dedupe`: after creating, re-read and remove any other comment for the allocation (a concurrent writer's). A
    // launch row needs none: its allocation id was just made.
    async upsert(row, { dedupe = false } = {}) {
      const issue = await current();
      const [counted, ...extras] = rowComments(comments, row.alloc).map((x) => x.c);
      const body = renderRow(row);
      if (!counted) {
        const made = await gh.createComment(repo, issue, body);
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
        if (!counted) await readComments();
        for (const extra of rowComments(comments, row.alloc).slice(1).map((x) => x.c)) {
          await gh.deleteComment(repo, extra.id).catch((err) => {
            if (err.status !== 404) throw err; // the other writer removed it first
          });
          comments = comments.filter((c) => c.id !== extra.id);
        }
      }
    },
    // Posts the day's line unless one is already on any open ledger issue. Returns whether it posted.
    async postDaily(line) {
      const issue = await current();
      if (dailyDays(comments).has(line.day)) return false;
      const body = renderDaily(line);
      const made = await gh.createComment(repo, issue, body);
      comments.push(made ?? { id: Number.MAX_SAFE_INTEGER, body });
      return true;
    },
  };
}
