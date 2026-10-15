// The pool ledger (spec I9): one comment per server session on the ledger issue, plus a weekly summary comment.
// A row is written as `deleting` just before the delete call and finalized in place once the server is gone,
// so a crash between the two leaves a row that the next deleter rewrites rather than a missing or double row.
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

// server: {id, created (ISO), type, location, price (€/h gross, or null), jobs (or null)}.
export function makeRow(server, { deleted, end, state }) {
  const billed = billedHours(Date.parse(server.created), deleted);
  return {
    server: server.id,
    created: new Date(Date.parse(server.created)).toISOString(),
    deleted: new Date(deleted).toISOString(),
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
  const deleted = row.state === 'deleting' ? `deleting ${utc(Date.parse(row.deleted))}` : utc(Date.parse(row.deleted));
  return [
    `<!-- ${ROW_MARK} ${JSON.stringify(row)} -->`,
    '| server id | created (UTC) | deleted (UTC) | type@location | billed h | € | jobs | end |',
    '|---|---|---|---|---|---|---|---|',
    `| ${row.server} | ${utc(Date.parse(row.created))} | ${deleted} | ${row.type}@${row.location} | ${row.billed} | ${dash(row.euros)} | ${dash(row.jobs)} | ${row.end} |`,
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

export function rowComment(comments, serverId) {
  return comments.find((c) => parseRow(c.body)?.server === serverId) ?? null;
}

export const rowsOf = (comments) => comments.map((c) => parseRow(c.body)).filter(Boolean);

const dayStart = (ms) => ms - (ms % DAY);

// Billed pool hours of sessions created on `now`'s UTC day: ledger rows, plus live servers that have none yet.
export function hoursOnDay(rows, liveServers, now) {
  const today = dayStart(now);
  const withRow = new Set(rows.map((r) => r.server));
  const fromRows = rows.filter((r) => dayStart(Date.parse(r.created)) === today).reduce((sum, r) => sum + r.billed, 0);
  const fromLive = liveServers
    .filter((s) => !withRow.has(s.id) && dayStart(Date.parse(s.created)) === today)
    .reduce((sum, s) => sum + billedHours(Date.parse(s.created), now), 0);
  return fromRows + fromLive;
}

export function weeklySummary(rows, now) {
  const from = now - 7 * DAY;
  const week = rows.filter((r) => Date.parse(r.deleted) > from && Date.parse(r.deleted) <= now);
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
