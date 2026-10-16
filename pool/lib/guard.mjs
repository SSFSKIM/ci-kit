// The guard's rules (spec §3 Guard): the pool's backstop, run every 10 minutes from pool-guard.yml.
// guardPlan is pure; pool/guard.mjs gathers its inputs and carries out the actions.
import { hasKitLabel } from '../../lib/hcloud.mjs';
import { hoursOnDay, makeRow } from './ledger.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
export const STALE_HEARTBEAT = 10 * MIN;
export const WAKE_AFTER = 5 * MIN;
export const ALERT_UPTIME = 12 * HOUR;
export const MAX_UPTIME = 24 * HOUR;
export const BUILDER_MAX_AGE = 2 * HOUR;
export const SUMMARY_EVERY = 7 * 24 * HOUR;

// The last successful reconciliation: the heartbeat label, or the server's creation before the first.
export function heartbeatOf(server) {
  const beat = Number(server.labels['ci-kit-heartbeat']);
  return Number.isFinite(beat) && beat > 0 ? beat * 1000 : Date.parse(server.created);
}

const minutes = (ms) => Math.floor(ms / MIN);

// input: {now, servers (any listing; only ci-kit-labelled ones are considered), queued (queued pool jobs),
//         rows (ledger rows), summaryAt (ms or null), cfg}
// Actions: delete {server, end, alert} | delete-builder {server, alert} | finalize {row: the final row}
//          | record {server: refresh its running row, creating it if missing} | alert {title, body}
//          | ensure {reason} | summary.
export function guardPlan({ now, servers, queued, rows, summaryAt, cfg }) {
  const actions = [];
  const pool = servers.filter((s) => hasKitLabel(s, 'pool'));
  const deleted = new Set();

  for (const s of pool) {
    const up = now - Date.parse(s.created);
    const silent = now - heartbeatOf(s);
    if (silent > STALE_HEARTBEAT) {
      deleted.add(s.id);
      actions.push({
        kind: 'delete', server: s, end: 'stale-heartbeat',
        alert: {
          title: `ci-kit alert: pool server ${s.id} deleted, heartbeat stale`,
          body: `The guard deleted pool server ${s.id} (created ${s.created}): no successful reconciliation for ${minutes(silent)} min.`,
        },
      });
    } else if (up > MAX_UPTIME) {
      deleted.add(s.id);
      actions.push({
        kind: 'delete', server: s, end: 'max-uptime',
        alert: { title: `ci-kit alert: pool server ${s.id} deleted after 24 h up`, body: `Pool server ${s.id} was up ${minutes(up)} min (created ${s.created}).` },
      });
    } else if (up > ALERT_UPTIME) {
      actions.push({ kind: 'alert', title: `ci-kit alert: pool server ${s.id} up more than 12 h`, body: `Pool server ${s.id} has been up since ${s.created}.` });
    }
  }

  const live = new Set(pool.map((s) => s.id));
  for (const row of rows) {
    if (live.has(row.server)) continue;
    if (row.state === 'deleting') actions.push({ kind: 'finalize', row: { ...row, state: 'final' } });
    // Gone without a deleter's row: most likely its watchdog, while GitHub was unreachable. Its last sighting
    // (when the row was last refreshed) stands in for the deletion time.
    if (row.state === 'running') {
      const session = { id: row.server, created: row.created, type: row.type, location: row.location, price: row.price, jobs: row.jobs };
      actions.push({ kind: 'finalize', row: makeRow(session, { deleted: Date.parse(row.seen), end: 'vanished', state: 'final' }) });
    }
  }

  const remaining = pool.filter((s) => !deleted.has(s.id));
  // Every live box has a row before any deleter needs one (spec Decision Log, ledger coverage); refreshing it each
  // cycle keeps its last sighting within one cycle of the truth.
  for (const s of remaining) actions.push({ kind: 'record', server: s });
  const oldest = queued.map((j) => Date.parse(j.created_at)).sort((a, b) => a - b)[0];
  if (remaining.length === 0 && oldest !== undefined && now - oldest > WAKE_AFTER) {
    actions.push({ kind: 'ensure', reason: `a pool job queued ${minutes(now - oldest)} min with no pool server` });
  }

  for (const b of servers.filter((s) => hasKitLabel(s, 'builder'))) {
    if (now - Date.parse(b.created) > BUILDER_MAX_AGE) {
      actions.push({
        kind: 'delete-builder', server: b,
        alert: { title: `ci-kit alert: bake builder ${b.id} left behind`, body: `Builder ${b.id} (run ${b.labels['ci-kit-run'] ?? '?'}, created ${b.created}) was more than 2 h old; the guard deleted it.` },
      });
    }
  }

  const today = new Date(now).toISOString().slice(0, 10);
  const hours = hoursOnDay(rows, pool, now);
  if (hours > cfg.max_hours_per_day) {
    actions.push({
      kind: 'alert',
      title: `ci-kit alert: pool hours on ${today} above ${cfg.max_hours_per_day}`,
      body: `${hours} billed pool hours on ${today} (UTC), above max_hours_per_day = ${cfg.max_hours_per_day}. The guard does not delete a box for this; the levers are in docs/pool.md.`,
    });
  }

  if (summaryAt === null || now - summaryAt >= SUMMARY_EVERY) actions.push({ kind: 'summary' });
  return actions;
}
