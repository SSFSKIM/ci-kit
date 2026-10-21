// The GCE ledger on GitHub (spec I12): one comment per allocation on the current ledger issue, plus the daily lines.
// The store holds the comments updated in the last 26 h (a VM lives at most max_run_minutes, and the daily line needs
// yesterday), so a read stays small however long an issue grows. Writes keep that copy current. The store lives as
// long as the launcher's instance, so after its first read of an issue it asks only for the comments updated since
// its last read, less READ_OVERLAP_MS for GitHub's listing lag (spec M3: a busy day's window is several pages, read
// one after another before every tick's first launch). An incremental read shows no deletion, so at most every
// FULL_READ_MS the store reads an issue's whole window again and forgets a comment GitHub no longer lists (another
// writer's dedupe removed it), unless that comment is too recent for the listing to show yet. A row never moves back: before an update the comment is read
// again and the write is dropped if the comment is already as far along (a final row is never rewritten). Issue
// comments have no compare-and-swap, so during an overlap of two ticks a row is eventually final rather than
// finalized once: a stale writer whose update lands in the milliseconds after another finalized the row rolls it back
// to running, and the next tick finalizes it again, possibly with a later deletion time and charge. As with every overlap (spec Decision Log, 2026-10-16), correctness does not rest
// on a single writer, and the overlap heals itself.
// Two writers that each created a row for one allocation converge on the one every reader counts.
//
// Rotation (ci-kit#25): GitHub accepts no new comment on an issue that has 2,500. The ledger is every open issue
// titled `issue_title` or `issue_title from <day>`; the newest (highest number) is current and takes new comments,
// and every one of them is read over the window, so a row stays in view wherever its comment lives and is updated
// there by its id. A read that finds the current issue at ROTATE_AT comments opens the next one. Two ticks that
// both do so open two; every reader then takes the newer as current, and the rows either wrote stay in view because
// both issues are read. An issue this store opened stays in its reads until GitHub's listing shows it. An older
// issue is closed once nothing on it was updated inside the window and the issue
// after it is a window old (a tick that listed before that one existed may still be writing to it).
import { renderRow, parseRow, rowComments, rowsOf, moreFinal, renderDaily, dailyDays } from './ledger.mjs';

export const WINDOW_MS = 26 * 3600_000;
// 500 below the cap: about two days at MAWS's rate, for a rotation that keeps failing, a count GitHub reports late,
// and the comments a tick already under way adds. An issue left behind therefore never reaches the cap.
export const ROTATE_AT = 2000;
export const READ_OVERLAP_MS = 5 * 60_000;
export const FULL_READ_MS = 5 * 60_000;

// `row` may replace `current` unless current is final or further along.
const mayWrite = (current, row) => current !== null && current.state !== 'final' && !moreFinal(current, row);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function createGceLedger(gh, { repo, issue_title: title }, { now = Date.now, log = () => {} } = {}) {
  const ledgerTitle = new RegExp(`^${escape(title)}( from \\d{4}-\\d{2}-\\d{2})?$`);
  let issues = []; // the open ledger issues, oldest first: the last is current
  // Issues this store opened that no listing has shown yet: GitHub lists a new issue only seconds after creating it.
  let opened = [];
  // Issue number → {readAt: when its last read began, wholeAt: when its last whole read began, byId: Map comment id →
  // comment}: the comments in the window.
  const held = new Map();
  const comments = () => [...held.values()].flatMap((h) => [...h.byId.values()]);
  const hold = (issue, c) => {
    if (!held.has(issue)) held.set(issue, { readAt: null, wholeAt: null, byId: new Map() });
    held.get(issue).byId.set(c.id, c);
  };
  const drop = (id) => {
    for (const h of held.values()) h.byId.delete(id);
  };

  async function open(previous) {
    const made = await gh.createIssue(repo, {
      title: `${title} from ${new Date(now()).toISOString().slice(0, 10)}`,
      body: 'The GCE pool ledger (ci-kit spec I12): one comment per GCE allocation, and the daily cost lines' +
        `${previous ? `, continuing #${previous}` : ''}. The launcher starts the next issue at ${ROTATE_AT} comments, ` +
        'below GitHub\'s cap of 2,500, and closes this one once nothing on it is inside its 26 h window.',
    });
    const issue = { number: made.number, comments: 0, created_at: made.created_at ?? new Date(now()).toISOString() };
    opened.push(issue);
    return issue;
  }

  // Each open issue's comments in the window, from what the store holds and what changed since it last read the issue.
  // Each issue's entry is updated in place, so a comment a concurrent write holds meanwhile is kept.
  async function readComments() {
    const t = now();
    const cutoff = new Date(t - WINDOW_MS).toISOString();
    for (const n of held.keys()) if (!issues.some((i) => i.number === n)) held.delete(n);
    for (const i of issues) if (!held.has(i.number)) held.set(i.number, { readAt: null, wholeAt: null, byId: new Map() });
    return Promise.all(issues.map(async (i) => {
      const h = held.get(i.number);
      const whole = h.wholeAt === null || t - h.wholeAt >= FULL_READ_MS;
      const since = whole ? cutoff : new Date(Math.max(t - WINDOW_MS, h.readAt - READ_OVERLAP_MS)).toISOString();
      const before = [...h.byId.values()];
      const fresh = await gh.issueComments(repo, i.number, { since });
      for (const [id, c] of h.byId) if (c.updated_at < cutoff) h.byId.delete(id);
      if (whole) {
        // Gone from GitHub: held before this read, not listed by it, and old enough that the listing would show it.
        const listed = new Set(fresh.map((c) => c.id));
        const settled = new Date(t - READ_OVERLAP_MS).toISOString();
        for (const c of before) if (!listed.has(c.id) && c.updated_at && c.updated_at < settled) h.byId.delete(c.id);
        h.wholeAt = t;
      }
      for (const c of fresh) h.byId.set(c.id, c);
      h.readAt = t;
      return [...h.byId.values()];
    }));
  }

  async function read() {
    const listed = (await gh.openIssues(repo)).filter((i) => !i.pull_request && ledgerTitle.test(i.title));
    opened = opened.filter((o) => !listed.some((i) => i.number === o.number));
    issues = [...listed, ...opened].sort((a, b) => a.number - b.number);
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
    return comments();
  }

  async function current() {
    if (!issues.length) await read();
    return issues.at(-1).number;
  }

  return {
    read,
    rows: async () => rowsOf(comments()),
    // Writes `row` over its allocation's comment unless that one is already further along; creates it if none.
    // `dedupe`: after creating, re-read and remove any other comment for the allocation (a concurrent writer's). A
    // launch row needs none: its allocation id was just made.
    async upsert(row, { dedupe = false } = {}) {
      const issue = await current();
      const [counted, ...extras] = rowComments(comments(), row.alloc).map((x) => x.c);
      const body = renderRow(row);
      if (!counted) {
        const made = await gh.createComment(repo, issue, body);
        hold(issue, made ?? { id: Number.MAX_SAFE_INTEGER, body });
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
        for (const extra of rowComments(comments(), row.alloc).slice(1).map((x) => x.c)) {
          await gh.deleteComment(repo, extra.id).catch((err) => {
            if (err.status !== 404) throw err; // the other writer removed it first
          });
          drop(extra.id);
        }
      }
    },
    // Whether the day's line is already on an open ledger issue, as the store last read them.
    hasDaily: (day) => dailyDays(comments()).has(day),
    // Posts the day's line unless one is already on any open ledger issue. Returns whether it posted.
    async postDaily(line) {
      const issue = await current();
      if (dailyDays(comments()).has(line.day)) return false;
      const body = renderDaily(line);
      const made = await gh.createComment(repo, issue, body);
      hold(issue, made ?? { id: Number.MAX_SAFE_INTEGER, body });
      return true;
    },
  };
}
