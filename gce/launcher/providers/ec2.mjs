// One configured EC2 account. No JIT or signed report URL is retained; recovery observes durable allocation identity and attempt coordinates.
import { DescribeInstancesCommand, DescribeImagesCommand, DescribeInstanceTypesCommand, DescribeAvailabilityZonesCommand,
  DescribeSpotPriceHistoryCommand, DescribeSpotInstanceRequestsCommand, RunInstancesCommand, TerminateInstancesCommand, DescribeVolumesCommand, DeleteVolumeCommand } from '@aws-sdk/client-ec2';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { providerRunnerLabels, providerRunnerName } from './contracts.mjs';
import { tagMap, poolJob, live, priceOf, launchResult, jobRequest, viewInstance, iso } from './ec2-data.mjs';
const filter = (Name, ...Values) => ({ Name, Values });
const pool = () => [filter('tag:ci-kit-pool', 'ec2'), filter('tag:ci-kit-purpose', 'job')];
const allInstances = (pages) => pages.flatMap((p) => (p.Reservations ?? []).flatMap((r) => r.Instances ?? []));
const hasAttempt = row => Boolean(row.zone && row.client_token && Number.isFinite(Date.parse(row.sent_at)));
const RECOVERY_GRACE_MS = 10 * 60_000;
const SEND_WINDOW_MS = 8 * 60_000; // leave two minutes for bounded SDK auth/request work before presend recovery
// Price/capacity codes are documented Spot status; by-experiment is pinned by the live FIS response fixture.
const SPOT_PREEMPTION_CODES = new Set(['instance-terminated-by-experiment', 'instance-terminated-by-price', 'instance-terminated-no-capacity']);

export function createProvider({ aws, account, cfg, now = Date.now, log = () => {} }) {
  let types = new Map(), zones = new Map(), prices = new Map(), image = null, imageRead;
  let observed = [];
  const pages = async (Command, input) => {
    const results = []; let NextToken;
    do { const page = await aws.ec2.send(new Command({ ...input, ...(NextToken ? { NextToken } : {}) })); results.push(page); NextToken = page.NextToken; } while (NextToken);
    return results;
  };
  const candidate = (placement, size, machine = placement.machines[size]) => {
    const type = types.get(machine);
    // Only machines whose real physical size/architecture we observed can be admitted.
    if (!type?.ProcessorInfo?.SupportedArchitectures?.includes('x86_64') || !type.VCpuInfo?.DefaultVCpus) return null;
    const quote = prices.get(`${placement.zone}/${machine}`);
    const snapshot = Number(tagMap(image ?? {})['ci-kit-snapshot-gib']);
    return { provider: 'ec2', account: account.account, region: account.region, zone: placement.zone, zoneId: zones.get(placement.zone),
      size, labels: providerRunnerLabels('ec2', size), machine, family: 'spot-standard-family', vcpus: type.VCpuInfo.DefaultVCpus,
      memoryGiB: type.MemoryInfo.SizeInMiB / 1024, arch: 'x86_64', provisioning: 'spot', subnet: placement.subnet,
      disk: { type: 'gp3', sizeGB: account.disk_gb }, price: priceOf({ hourly: quote?.hourly, at: quote?.at ?? iso(now()),
        snapshotGiB: Number.isFinite(snapshot) ? snapshot : undefined, initializationMiBps: account.initialization_mibps }) };
  };
  const find = async (row) => {
    if (!hasAttempt(row)) {
      // The initial ledger write precedes JIT and attempt coordinates. Still look for its allocation
      // defensively: a discovered VM is adopted, never abandoned just because those coordinates are absent.
      return allInstances(await pages(DescribeInstancesCommand, { Filters: [...pool(), filter('tag:ci-kit-alloc', row.alloc)] }))
        .find(i => poolJob(i) && tagMap(i)['ci-kit-alloc'] === row.alloc) ?? null;
    }
    const shared = [...pool(), filter('availability-zone', row.zone)];
    // Two queries are OR evidence; combining tag and token filters would require both to match.
    const results = await Promise.all([filter('tag:ci-kit-alloc', row.alloc), filter('client-token', row.client_token)]
      .map((coordinate) => pages(DescribeInstancesCommand, { Filters: [...shared, coordinate] })));
    return allInstances(results.flat()).find((i) => poolJob(i) && i.Placement?.AvailabilityZone === row.zone
      && (tagMap(i)['ci-kit-alloc'] === row.alloc || i.ClientToken === row.client_token)) ?? null;
  };
  const provider = {
    name: 'ec2', account: account.account,
    candidates: (_config, size) => account.placements.map((p) => candidate(p, size)).filter(Boolean),
    async readyImage() {
      imageRead ??= (async () => {
        const found = (await pages(DescribeImagesCommand, { Owners: ['self'], Filters: [filter('tag:ci-kit-pool', 'ec2'), filter('tag:ci-kit-ready', 'true'), filter('state', 'available')] })).flatMap((p) => p.Images ?? []);
        image = found.filter((i) => i.State === 'available' && tagMap(i)['ci-kit-pool'] === 'ec2' && tagMap(i)['ci-kit-ready'] === 'true')
          .sort((a, b) => b.CreationDate.localeCompare(a.CreationDate))[0] ?? null;
        return image ? { id: image.ImageId, manifest: tagMap(image) } : null;
      })();
      return imageRead;
    },
    async observe({ rows: pendingRows = [] } = {}) {
      const rows = await pendingRows;
      // Image failure prevents new launches but never removes management of existing instances.
      const listing = await pages(DescribeInstancesCommand, { Filters: pool() });
      observed = allInstances(listing).filter(poolJob);
      const machines = [...new Set([...account.placements.flatMap((p) => Object.values(p.machines)), ...observed.filter(live).map((i) => i.InstanceType)])];
      const [typePages, zonePages, volumePages] = await Promise.all([
        pages(DescribeInstanceTypesCommand, { InstanceTypes: machines }),
        pages(DescribeAvailabilityZonesCommand, {}),
        pages(DescribeVolumesCommand, { Filters: pool() }),
        provider.readyImage().catch(() => null),
      ]);
      types = new Map(typePages.flatMap((p) => p.InstanceTypes ?? []).map((t) => [t.InstanceType, t]));
      zones = new Map(zonePages.flatMap((p) => p.AvailabilityZones ?? []).map((z) => [z.ZoneName, z.ZoneId]));
      try {
        const quotes = (await pages(DescribeSpotPriceHistoryCommand, { InstanceTypes: machines, ProductDescriptions: ['Linux/UNIX'], StartTime: new Date(now()) })).flatMap((p) => p.SpotPriceHistory ?? []);
        prices = new Map();
        for (const q of quotes.sort((a, b) => Date.parse(a.Timestamp) - Date.parse(b.Timestamp))) prices.set(`${q.AvailabilityZone}/${q.InstanceType}`, { hourly: Number(q.SpotPrice), at: iso(q.Timestamp) });
      } catch (err) { log(`ec2 ${account.account}: spot prices unavailable (${err.name}); instances remain managed, new rows unpriced`); }
      const instances = observed.filter(live).map((i) => {
        const t = tagMap(i), size = Number(t['ci-kit-cpus']);
        const p = { zone: i.Placement.AvailabilityZone, subnet: i.SubnetId, machines: { [size]: i.InstanceType } };
        const c = candidate(p, size);
        if (!c) throw new Error(`EC2 inventory lacks physical capacity for ${i.InstanceType}`);
        return viewInstance(i, c, rows.find((r) => r.alloc === t['ci-kit-alloc']));
      });
      return { instances, complete: true, volumes: volumePages.flatMap((p) => p.Volumes ?? []) };
    },
    async launch(row, c, jit) {
      const sendBy = Date.parse(row.at) + SEND_WINDOW_MS;
      if (!Number.isFinite(sendBy)) return { outcome: 'abandoned', detail: 'allocation time is required before sending' };
      let request;
      try {
        const report = Object.fromEntries(await Promise.all(['boot', 'notice', 'exit'].map(async (kind) => [kind,
          await aws.presignPut({ bucket: account.report_bucket, key: `reports/${row.alloc}/${kind}.json`, expiresIn: 9000 })])));
        request = jobRequest({ row, candidate: c, account, maxRunMinutes: cfg.max_run_minutes, jit, report, rootDevice: image?.RootDeviceName });
      } catch (err) { return { outcome: 'denied', detail: `prepare EC2 request: ${err.name}` }; }
      // Check after asynchronous credential/signing work too: an old writer must not send after another
      // launcher can retire its initial row. Local expiry is not an account denial or a request to replay.
      if (now() >= sendBy) return { outcome: 'abandoned', detail: 'allocation send deadline exceeded' };
      try {
        const response = await aws.ec2.send(new RunInstancesCommand(request));
        const id = response.Instances?.[0]?.InstanceId;
        return id ? { outcome: 'accepted', id, detail: '' } : { outcome: 'uncertain', detail: 'RunInstances returned no instance id' };
      } catch (err) { return launchResult(err, account); }
    },
    async reconcileLaunch(row) {
      try {
        const found = await find(row);
        if (found) {
          if (!types.has(found.InstanceType)) {
            const response = await aws.ec2.send(new DescribeInstanceTypesCommand({ InstanceTypes: [found.InstanceType] }));
            for (const type of response.InstanceTypes ?? []) types.set(type.InstanceType, type);
          }
          const c = candidate({ zone: found.Placement.AvailabilityZone, subnet: found.SubnetId, machines: { [row.cpus]: found.InstanceType } }, row.cpus);
          if (!c) return { outcome: 'uncertain', detail: 'instance capacity unknown' };
          return { outcome: 'accepted', id: found.InstanceId, detail: '', instance: viewInstance(found, c, row) };
        }
        // A fresh coordinate-free row can belong to an overlapping active writer. The finite grace starts
        // at the initial write; submitted attempts retain their existing ten minutes from sent_at.
        const since = hasAttempt(row) ? row.sent_at : row.at;
        return { outcome: now() - Date.parse(since) >= RECOVERY_GRACE_MS ? 'abandoned' : 'uncertain', detail: 'no instance observed for allocation' };
      } catch (err) { log(`ec2 ${account.account}: reconciliation observation failed (${err.name})`); return { outcome: 'uncertain', detail: 'observation failed' }; }
    },
    terminate: (instance) => aws.ec2.send(new TerminateInstancesCommand({ InstanceIds: [instance.id ?? instance.instance_id] })),
    async stillThere(row) {
      try {
        const found = row.instance_id ? allInstances(await pages(DescribeInstancesCommand, { InstanceIds: [row.instance_id] })).find(live) : await find(row);
        return Boolean(found && live(found));
      } catch (err) { if (err.name === 'InvalidInstanceID.NotFound') return false; return true; }
    },
    async preemptions() {
      try {
        const gone = allInstances(await pages(DescribeInstancesCommand, { Filters: [...pool(), filter('instance-state-name', 'terminated', 'shutting-down')] }))
          .filter(i => poolJob(i) && !live(i));
        const ids = [...new Set(gone.filter(i => i.StateReason?.Code !== 'Server.SpotInstanceTermination')
          .map(i => i.SpotInstanceRequestId).filter(Boolean))];
        const requests = ids.length ? (await pages(DescribeSpotInstanceRequestsCommand, { SpotInstanceRequestIds: ids }))
          .flatMap(p => p.SpotInstanceRequests ?? []) : [];
        const byRequest = new Map(requests.map(r => [r.SpotInstanceRequestId, r]));
        // Status.UpdateTime can be the notice time, not termination. Preserve transition/observation bounds.
        return new Map(gone.filter(i => {
          if (i.StateReason?.Code === 'Server.SpotInstanceTermination') return true;
          const request = byRequest.get(i.SpotInstanceRequestId);
          return request?.InstanceId === i.InstanceId && SPOT_PREEMPTION_CODES.has(request?.Status?.Code);
        }).map(i => [providerRunnerName('ec2', tagMap(i)['ci-kit-alloc']), transitionTime(i) ?? now()]));
      } catch (err) { log(`ec2 ${account.account}: preemptions unavailable (${err.name})`); return null; }
    },
    async readReports(allocs) {
      return new Map(await Promise.all(allocs.map(async (row) => {
        const bundle = { telemetry: [] };
        await Promise.all(['boot', 'notice', 'exit'].map(async (kind) => {
          try {
            const result = await aws.s3.send(new GetObjectCommand({ Bucket: account.report_bucket, Key: `reports/${row.alloc}/${kind}.json` }));
            const text = await result.Body.transformToString();
            if (Buffer.byteLength(text) > 64 * 1024) return;
            const report = JSON.parse(text);
            if (report.alloc !== row.alloc) return;
            if (kind === 'exit') {
              if (typeof report.value === 'string' && /^(exit:-?\d+|failed:[a-zA-Z0-9_-]+)$/.test(report.value)) bundle.terminal = { ...report, kind: 'terminal' };
            } else bundle.telemetry.push({ ...report, kind: report.kind === 'claimed' ? 'claimed' : 'telemetry' });
          } catch (err) { if (!['NoSuchKey', 'NotFound'].includes(err.name)) log(`ec2 ${account.account}: ${kind} report unavailable for ${row.alloc} (${err.name})`); }
        }));
        return [row.alloc, bundle];
      })));
    },
    async cleanupOrphans(inventory) {
      if (!inventory.complete) return [];
      const removed = [];
      for (const volume of inventory.volumes ?? []) {
        const t = tagMap(volume);
        if (t['ci-kit-pool'] !== 'ec2' || t['ci-kit-purpose'] !== 'job' || volume.State !== 'available' || volume.Attachments?.length || now() - Date.parse(volume.CreateTime) < 10 * 60_000) continue;
        await aws.ec2.send(new DeleteVolumeCommand({ VolumeId: volume.VolumeId })).catch(err => {
          if (err.name !== 'InvalidVolume.NotFound') throw err; // concurrent shutdown/guard already removed it
        });
        removed.push(`volume ${volume.VolumeId}`);
      }
      return removed;
    },
  };
  return provider;
}

// EC2's reason text includes the actual transition time; polling observation time is not the lifecycle proof.
function transitionTime(i) {
  const text = /\((\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) GMT\)/.exec(i.StateTransitionReason ?? '')?.[1];
  return text ? Date.parse(`${text.replace(' ', 'T')}Z`) : null;
}
