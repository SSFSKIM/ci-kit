// Compute Engine effects for the ephemeral pool. Admission, allocations, JIT and ledger writes stay in Launcher.
// The extra GCE view fields and walk error metadata preserve the single-cloud scheduler until M4 consumes the
// neutral Candidate/Instance/LaunchResult boundary. No request (and no JIT secret) is retained by this provider.
import { GceError } from '../../../lib/gce.mjs';
import { staleBakeInstances } from '../../bake/plan.mjs';
import { placementZones } from '../config.mjs';
import {
  placements, viewInstance, isGce, newestReadyImage, jobInstance, insertOutcome, unsettledInsert,
  pendingAllocation, largestMachineCpus, orphanDisks,
} from '../logic.mjs';
import { createRoom, limitsCache, readLimits } from '../room.mjs';
import { createPreparation } from '../preparation.mjs';
import { natDay } from '../ledger.mjs';

const SETTLE_BUDGET_MS = 15_000;
const SETTLE_PARALLEL = 4;
const SEND_SKEW_MS = 2_000;
const INSERT_DEADLINE_MS = 40_000;
const NAT_GATEWAY = 'ci-kit-nat';
const iso = (ms) => new Date(ms).toISOString();
const zoneOf = (r) => r.zone.split('/').pop();
const timer = (ms) => {
  let id;
  const promise = new Promise((resolve) => { id = setTimeout(resolve, ms); });
  return { promise, cancel: () => clearTimeout(id) };
};

// Keep the old walk's distinctions and original GceError (quota metric, scope and operation link) without exposing
// its internal outcome names as the Provider API. Definitive non-capacity/quota refusals still stop the GCE walk.
function resultOf(error = null, extra = {}) {
  const legacy = error ? insertOutcome(error) : 'created';
  const outcome = { created: 'accepted', unknown: 'uncertain', failed: error?.status === 429 ? 'throttled' : 'denied' }[legacy] ?? legacy;
  return { outcome, detail: error?.message ?? '', ...(error ? { error } : {}), ...extra };
}
export function gceWalkResult(result) {
  return { outcome: { accepted: 'created', uncertain: 'unknown', denied: 'failed', throttled: 'failed' }[result.outcome] ?? result.outcome,
    ...(result.error ? { error: result.error } : {}) };
}

function settledAs(op, now) {
  const errors = op.error?.errors;
  const error = errors?.length ? new GceError(op.httpErrorStatusCode ?? 200,
    `gce operation ${op.name}: ${errors.map((e) => `${e.code} ${e.message ?? ''}`.trim()).join('; ')}`,
    errors.map((e) => e.code), { accepted: true, finished: true, operation: op.selfLink ?? null }) : null;
  return resultOf(error, { done: op.endTime ?? iso(now()) });
}

// Match a persisted unsettled insert by operation link, else by name and send time. The same allocation may have
// tried this zone earlier (spot then standard); that earlier operation is not evidence about the current attempt.
function operationOf(ops, instance, insert) {
  const mine = ops.filter((o) => o.operationType === 'insert' && o.targetLink.endsWith(`/instances/${instance}`));
  if (insert.operation) return mine.find((o) => o.selfLink === insert.operation) ?? null;
  const after = Date.parse(insert.sent) - SEND_SKEW_MS;
  return mine.filter((o) => Date.parse(o.insertTime) >= after).sort((a, b) => Date.parse(b.insertTime) - Date.parse(a.insertTime))[0] ?? null;
}

// The server keeps this cache across ticks; a provider is configured for one tick's config revision.
export const createLimits = (gce, log) => limitsCache({ read: (placements) => readLimits(gce, placements), log });

export function createProvider({ gce, cfg, config, now = Date.now, log = () => {}, after = timer, limits,
  insertDeadlineMs = INSERT_DEADLINE_MS }) {
  const recorder = () => createPreparation({ now });
  const uncertain = () => ({ outcome: 'uncertain', detail: '' });
  const provider = {
    name: 'gce', account: cfg.project,
    candidates: (config, size) => placements(size, config),

    // Start limits beside the ledger read, but list VMs only AFTER that read: a running row must precede the
    // inventory used to decide its VM vanished. room resolves independently, so a slow quota read cannot hold
    // inventory/cleanup; the scheduler bounds its wait only when it has a launch to make.
    async observe({ rows: pendingRows = [], preparation = recorder() } = {}) {
      const knownLimits = limits ? preparation.time('limits.get', () => limits.get(cfg.placements)) : Promise.resolve(null);
      const rows = await pendingRows;
      const [listing, disks, builders] = await Promise.all([
        preparation.time('gce.listInstances', () => gce.listInstances('labels.ci-kit=gce')),
        preparation.time('gce.listDisks', () => gce.listDisks('labels.ci-kit=gce')),
        preparation.time('gce.builders', () => gce.instances('labels.ci-kit=gce-builder')),
      ]);
      const instances = listing.items.filter(isGce).map(viewInstance);
      const live = rows.filter((r) => r.state !== 'final');
      const ours = new Set([...placementZones(cfg), ...live.filter((r) => r.zone).map((r) => r.zone)]);
      const missing = [...ours].filter((z) => !listing.zones.has(z));
      if (live.some((r) => !r.zone) && !listing.complete) missing.push('a zone (a live row names none)');
      const complete = missing.length === 0;
      if (!complete) log(`the instance listing missed ${missing.join(', ')}: no launches, and no cleanup by absence, this tick`);
      const room = knownLimits.then((limits) => {
        const bake = builders.filter((b) => b.labels?.['ci-kit'] === 'gce-builder').map(viewInstance);
        const listed = new Set(instances.map((i) => i.alloc));
        const pending = rows.filter((r) => !listed.has(r.alloc) && pendingAllocation(r) && unsettledInsert(r)?.zone)
          .map((r) => ({ zone: unsettledInsert(r).zone, vcpus: r.reserved ?? largestMachineCpus(r.cpus, cfg), egress: r.egress }));
        return createRoom({ account: cfg.project, limits, instances: [...instances, ...bake], pending, placements: cfg.placements, egress: cfg.egress });
      });
      room.catch(() => {}); // like the image read, only a tick with demand awaits this
      return { instances, complete, room, rows, disks: disks.items, builders };
    },

    async readyImage(preparation = recorder()) {
      const image = newestReadyImage(await preparation.time('gce.images', () => gce.images('labels.ci-kit=gce-image')), cfg.image_family);
      return image ? { id: image.selfLink, manifest: image.labels ?? {} } : null;
    },

    async launch(alloc, candidate, jit) {
      try {
        await gce.insertInstance(candidate.zone, jobInstance({
          alloc: alloc.alloc, ...candidate, repo: alloc.repo, cpus: alloc.cpus, image: alloc.image, jit, cfg, config: alloc.config ?? config,
          placement: candidate.placement ?? { region: candidate.region, subnetwork: candidate.subnet, disk_type: candidate.disk.type },
        }), { deadlineMs: insertDeadlineMs });
        return resultOf();
      } catch (err) {
        return resultOf(err);
      }
    },

    // A persisted slow entry uses its send time; an in-tick reconciliation carries zone/operation directly and
    // retains the old fallback to a direct instance read when no operation can be found.
    async reconcileLaunch(alloc, { operations } = {}) {
      const insert = unsettledInsert(alloc);
      const zone = insert?.zone ?? alloc.zone;
      try {
        let op;
        if (insert) {
          const ops = operations ?? await gce.zoneOperations(zone, `targetLink eq ".*/instances/${alloc.instance}"`);
          op = operationOf(ops, alloc.instance, insert);
        } else {
          op = alloc.operation ? await gce.operation(alloc.operation)
            : (await gce.zoneOperations(zone, `targetLink eq ".*/instances/${alloc.instance}"`)).find((o) => o.operationType === 'insert') ?? null;
        }
        if (op) return op.status === 'DONE' ? settledAs(op, now) : uncertain();
        if (insert) return uncertain();
        return (await gce.instance(zone, alloc.instance)) ? resultOf() : uncertain();
      } catch (err) {
        log(`reconcile ${alloc.instance}: ${err.message}`);
        return uncertain();
      }
    },

    // Late settlement reads one operation list per zone, at most four at once and within the original tick budget.
    // Only observations are returned: allocation finalization, JIT removal and ledger writes remain the scheduler's.
    async reconcileLaunches(rows) {
      const byZone = new Map();
      for (const row of rows) {
        const insert = unsettledInsert(row);
        if (insert) byZone.set(insert.zone, [...(byZone.get(insert.zone) ?? []), row]);
      }
      if (!byZone.size) return new Map();
      const read = new Map();
      let expired = false;
      const budget = after(SETTLE_BUDGET_MS);
      const zones = [...byZone.keys()];
      const worker = async () => {
        while (zones.length && !expired) {
          const zone = zones.shift();
          const names = byZone.get(zone).map((r) => r.instance);
          try {
            const ops = await gce.zoneOperations(zone, `targetLink eq ".*/instances/(${names.join('|')})"`);
            if (!expired) read.set(zone, ops);
          } catch (err) {
            log(`insert operations in ${zone}: ${err.message}; their rows wait for the next tick`);
          }
        }
      };
      await Promise.race([
        Promise.all(Array.from({ length: Math.min(SETTLE_PARALLEL, zones.length) }, worker)),
        budget.promise.then(() => { expired = true; }),
      ]);
      budget.cancel();
      if (expired) log(`unsettled inserts: not all read in ${SETTLE_BUDGET_MS / 1000} s; the rest wait for the next tick`);
      return new Map(await Promise.all([...read].flatMap(([zone, ops]) => byZone.get(zone).map(async (row) =>
        [row.alloc, await provider.reconcileLaunch(row, { operations: ops })]))));
    },

    terminate: (instance) => gce.deleteInstance(instance.candidate?.zone ?? instance.zone, instance.runner ?? instance.name, { wait: false }),

    async readReports(allocs, preparation = recorder()) {
      return new Map(await Promise.all(allocs.map(async (a) => {
        let value = null;
        try {
          value = await preparation.time('gce.jobReport', () => gce.guestAttribute(a.zone, a.instance, 'ci-kit/job'), { instance: a.instance, zone: a.zone });
        } catch (err) {
          if (err.status !== 404) log(`ci-kit/job of ${a.instance}: ${err.message}`);
        }
        return [a.alloc, { telemetry: [], ...(value ? { terminal: { kind: 'terminal', value } } : {}) }];
      })));
    },

    async cleanupOrphans(inventory) {
      const removed = [];
      const at = now();
      for (const d of orphanDisks(inventory.disks, at)) {
        await gce.deleteDisk(zoneOf(d), d.name, { wait: false })
          .then(() => removed.push(`disk ${d.name}`), (err) => log(`delete disk ${d.name}: ${err.message}`));
      }
      for (const b of staleBakeInstances(inventory.builders, at)) {
        await gce.deleteInstance(zoneOf(b), b.name, { wait: false })
          .then(() => removed.push(`${b.name} (old builder)`), (err) => log(`delete ${b.name}: ${err.message}`));
      }
      return removed;
    },

    async stillThere(row) {
      try {
        return Boolean(await gce.instance(row.zone, row.instance));
      } catch (err) {
        log(`confirm ${row.instance}: ${err.message}`);
        return true;
      }
    },

    async preemptions() {
      try {
        const ops = await gce.operations('operationType="compute.instances.preempted"');
        return new Map(ops.map((op) => [op.targetLink.split('/').pop(), Date.parse(op.insertTime ?? op.endTime)]));
      } catch (err) {
        log(`preemptions unreadable, vanished VMs wait for the next tick: ${err.message}`);
        return null;
      }
    },

    async natOf(dayIso) {
      const start = `${dayIso}T00:00:00.000Z`;
      const end = iso(Date.parse(start) + 24 * 3600_000);
      const read = (metric, perSeriesAligner) => gce.timeSeries(
        `metric.type="router.googleapis.com/nat/${metric}" AND resource.type="nat_gateway" AND resource.labels.gateway_name="${NAT_GATEWAY}"`,
        { start, end, aggregation: { alignmentPeriod: '86400s', perSeriesAligner, crossSeriesReducer: 'REDUCE_SUM', groupByFields: 'resource.labels.region' } },
      );
      try {
        const [sent, received, ports] = await Promise.all([read('sent_bytes_count', 'ALIGN_SUM'), read('received_bytes_count', 'ALIGN_SUM'), read('allocated_ports', 'ALIGN_COUNT')]);
        return natDay({ sent, received, ports });
      } catch (err) {
        log(`NAT use of ${dayIso} unread: ${err.message}`);
        return { unread: true };
      }
    },
  };
  return provider;
}
