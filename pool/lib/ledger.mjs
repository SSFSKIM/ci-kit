// The pool ledger (spec I9): one comment per server session on the ledger issue, plus a weekly summary comment.
// Every session gets a provisional `running` row before any deleter can need one (the agent at boot, the guard
// for a server it sees without a row). A deleter rewrites it as `deleting` just before its delete call, and it is
// finalized in place once the server is gone. A row never moves back down that order. Concurrent writers can
// still make two comments for one server; readers count the most final one, and writers delete the rest.
const ROW_MARK = 'ci-kit-ledger';
const SUMMARY_MARK = 'ci-kit-ledger-summary';
const HOUR = 3600_000;
const DAY = 24 * HOUR;

const round2 = (n) => Math.round(n * 100) / 100;
const utc = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

// Hetzner bills every started hour of a server's life (spec Context).
export function billedHours(createdMs, deletedMs) {
  return Math.max(1, Math.ceil((deletedMs - createdMs) / HOUR));
}

export const STATES = ['running', 'deleting', 'final'];
const rank = (row) => STATES.indexOf(row.state);
export const moreFinal = (a, b) => rank(a) > rank(b);

// server: {id, created (ISO), type, location, price (€/h gross, or null), jobs (or null)}.
// A `running` row takes `at` (when it was written; billed hours so far); the others take `deleted` and `end`.
export function makeRow(server, { deleted = null, end = null, state, at = null }) {
  const until = state === 'running' ? at : deleted;
  const billed = billedHours(Date.parse(server.created), until);
  return {
    server: server.id,
    created: new Date(Date.parse(server.created)).toISOString(),
    deleted: deleted === null ? null : new Date(deleted).toISOString(),
    ...(state === 'running' ? { seen: new Date(at).toISOString() } : {}),
    type: server.type,
    location: server.location,
    price: server.price ?? null,
    billed,
    euros: server.price == null ? null : round2(billed * server.price),
    jobs: server.jobs ?? null,
    end,
    state,
  };
}

const dash = (v) => (v == null ? '-' : String(v));

export function renderRow(row) {
  const deleted = {
    running: () => `running, seen ${utc(Date.parse(row.seen))}`,
    deleting: () => `deleting ${utc(Date.parse(row.deleted))}`,
    final: () => utc(Date.parse(row.deleted)),
  }[row.state]();
  return [
    `<!-- ${ROW_MARK} ${JSON.stringify(row)} -->`,
    '| server id | created (UTC) | deleted (UTC) | type@location | billed h | € | jobs | end |',
    '|---|---|---|---|---|---|---|---|',
    `| ${row.server} | ${utc(Date.parse(row.created))} | ${deleted} | ${row.type}@${row.location} | ${row.billed} | ${dash(row.euros)} | ${dash(row.jobs)} | ${dash(row.end)} |`,
  ].join('\n');
}

function marked(body, mark) {
  const m = new RegExp(`^<!-- ${mark} (\\{.*\\}) -->`).exec(body ?? '');
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

export const parseRow = (body) => marked(body, ROW_MARK);

// One server's row comments, the one that counts first: the most final, then the oldest comment. Every reader
// and writer orders them the same way, so concurrent writers reconcile to the same comment.
function rowComments(comments, serverId) {
  return comments
    .map((c) => ({ c, row: parseRow(c.body) }))
    .filter((x) => x.row && (serverId === undefined || x.row.server === serverId))
    .sort((a, b) => rank(b.row) - rank(a.row) || a.c.id - b.c.id);
}

export function rowComment(comments, serverId) {
  return rowComments(comments, serverId)[0]?.c ?? null;
}

// The comments for one server beyond the one that counts: a writer that finds them deletes them.
export const extraRowComments = (comments, serverId) => rowComments(comments, serverId).slice(1).map((x) => x.c);

// One row per server id.
export function rowsOf(comments) {
  const seen = new Set();
  const rows = [];
  for (const { row } of rowComments(comments)) {
    if (seen.has(row.server)) continue;
    seen.add(row.server);
    rows.push(row);
  }
  return rows;
}

const dayStart = (ms) => ms - (ms % DAY);

// Billed pool hours on `day`'s UTC day (default: today): each billed hour counts on the day it begins. A session
// runs from its created time to its deleted time; a live one to now; a running row whose server is gone, to when
// the row was last written. Live servers without a row count too.
export function hoursOnDay(rows, liveServers, now, day = now) {
  const from = dayStart(day);
  const to = from + DAY;
  const live = new Map(liveServers.map((s) => [s.id, s]));
  const sessions = rows.map((r) => {
    const end = r.deleted ? Date.parse(r.deleted) : live.has(r.server) ? now : Date.parse(r.seen);
    return [Date.parse(r.created), end];
  });
  const withRow = new Set(rows.map((r) => r.server));
  for (const s of liveServers) if (!withRow.has(s.id)) sessions.push([Date.parse(s.created), now]);
  let hours = 0;
  for (const [start, end] of sessions) {
    for (let k = 0; k < billedHours(start, end); k += 1) {
      const begins = start + k * HOUR;
      if (begins >= from && begins < to) hours += 1;
    }
  }
  return hours;
}

export function weeklySummary(rows, now) {
  const from = now - 7 * DAY;
  const week = rows.filter((r) => r.deleted && Date.parse(r.deleted) > from && Date.parse(r.deleted) <= now);
  const euros = round2(week.reduce((sum, r) => sum + (r.euros ?? 0), 0));
  return {
    from: new Date(from).toISOString(),
    to: new Date(now).toISOString(),
    sessions: week.length,
    hours: week.reduce((sum, r) => sum + r.billed, 0),
    euros,
    jobs: week.reduce((sum, r) => sum + (r.jobs ?? 0), 0),
    month: round2((euros / 7) * 30),
  };
}

export function renderSummary(s) {
  return [
    `<!-- ${SUMMARY_MARK} ${JSON.stringify({ at: s.to })} -->`,
    `**Weekly pool cost** (${s.from.slice(0, 10)} to ${s.to.slice(0, 10)}): ` +
      `${s.sessions} sessions, ${s.hours} billed hours, €${s.euros.toFixed(2)}, ${s.jobs} jobs; ` +
      `projected month €${s.month.toFixed(2)} at this week's rate.`,
  ].join('\n');
}

export function lastSummaryAt(comments) {
  const times = comments.map((c) => marked(c.body, SUMMARY_MARK)?.at).filter(Boolean).map(Date.parse);
  return times.length ? Math.max(...times) : null;
}
