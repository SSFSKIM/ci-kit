// EC2 request/data boundaries. The scheduler owns allocations, persisted attempt coordinates and JIT registration.
import { providerRunnerLabels, providerRunnerName } from './contracts.mjs';
export const tagMap = (resource) => Object.fromEntries((resource.Tags ?? []).map(({ Key, Value }) => [Key, Value]));
export const tags = (values) => Object.entries(values).map(([Key, Value]) => ({ Key, Value: String(Value) }));
export const iso = (value) => new Date(value).toISOString();
export const poolJob = (i) => { const t = tagMap(i); return t['ci-kit-pool'] === 'ec2' && t['ci-kit-purpose'] === 'job' && t['ci-kit-alloc']; };
export const live = (i) => !['terminated', 'shutting-down'].includes(i.State?.Name);

// Ohio gp3 $0.08/GiB-month, public IPv4 $0.005/hour; provisioned initialization $0.0024/GiB up to
// 200 MiB/s, $0.0036 above it (M1 price evidence, 2026-10-23). Compute is the zone's observed spot quote.
export function priceOf({ hourly, at, snapshotGiB, initializationMiBps }) {
  return { source: Number.isFinite(hourly) ? 'ec2-spot' : 'unpriced', at,
    computeHourlyUsd: Number.isFinite(hourly) ? hourly : null, diskGiBMonthlyUsd: 0.08, ipv4HourlyUsd: 0.005,
    initializationUsd: initializationMiBps ? (Number.isFinite(snapshotGiB) ? snapshotGiB * (initializationMiBps <= 200 ? 0.0024 : 0.0036) : null) : 0 };
}
export function ec2Dollars(row, seconds, end) {
  const p = row.price;
  if (!p || ![p.computeHourlyUsd, p.diskGiBMonthlyUsd, p.ipv4HourlyUsd, p.initializationUsd, row.disk_gb].every(Number.isFinite)) return null;
  // Linux Spot is free only when EC2 interrupts in the FIRST hour; later interruptions bill seconds used.
  // https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/billing-for-interrupted-spot-instances.html
  const computeSeconds = end === 'preempted' && seconds < 3600 ? 0 : Math.max(60, seconds);
  // gp3 provisioned storage has its own 60-second minimum, including EC2-interrupted boots.
  return computeSeconds * p.computeHourlyUsd / 3600 + Math.max(60, seconds) * row.disk_gb * p.diskGiBMonthlyUsd / (30 * 86400)
    + seconds * p.ipv4HourlyUsd / 3600 + p.initializationUsd;
}
export function launchResult(error, account) {
  const code = error.name ?? error.Code;
  const outcome = ['InsufficientInstanceCapacity', 'SpotMaxPriceTooLow', 'Unsupported'].includes(code) ? 'capacity'
    : ['MaxSpotInstanceCountExceeded', 'VcpuLimitExceeded'].includes(code) ? 'quota'
      : code === 'RequestLimitExceeded' ? 'throttled'
        : ['UnauthorizedOperation', 'AuthFailure', 'InvalidIdentityToken', 'AccessDenied', 'AccessDeniedException', 'ExpiredToken', 'IDPRejectedClaim'].includes(code) || (error.$metadata?.httpStatusCode >= 400 && error.$metadata?.httpStatusCode < 500) ? 'denied' : 'uncertain';
  // SDK errors can embed signed requests. Only the service code is safe to log or persist.
  return { outcome, detail: code || 'transport error', ...(outcome === 'quota' ? { scope: `ec2/${account.account}/${account.region}/spot-standard-family` } : {}) };
}
export function jobRequest({ row, candidate: c, account, maxRunMinutes, jit, report, rootDevice = '/dev/sda1' }) {
  if (!row.client_token || !Number.isFinite(Date.parse(row.sent_at)) || row.zone !== c.zone) throw new Error('invalid persisted attempt coordinates');
  const sent = Date.parse(row.sent_at);
  const userData = JSON.stringify({ v: 1, alloc: row.alloc, repo: row.repo, jit, deadline: iso(sent + maxRunMinutes * 60_000), report });
  if (Buffer.byteLength(userData) > 16 * 1024) throw new Error('user-data exceeds EC2 16 KiB limit');
  const resourceTags = tags({ 'ci-kit-pool': 'ec2', 'ci-kit-alloc': row.alloc, 'ci-kit-repo': row.repo.replace('/', '--'),
    'ci-kit-cpus': row.cpus, 'ci-kit-purpose': 'job', 'ci-kit-deadline': iso(sent + (maxRunMinutes + 15) * 60_000),
    'ci-kit-disk-gb': c.disk.sizeGB, 'ci-kit-price': JSON.stringify(c.price) });
  return { ImageId: row.image, InstanceType: c.machine, MinCount: 1, MaxCount: 1, ClientToken: row.client_token,
    NetworkInterfaces: [{ DeviceIndex: 0, SubnetId: c.subnet, Groups: [account.security_group], AssociatePublicIpAddress: true, DeleteOnTermination: true }],
    BlockDeviceMappings: [{ DeviceName: rootDevice, Ebs: { VolumeType: 'gp3', VolumeSize: c.disk.sizeGB, Encrypted: true, DeleteOnTermination: true, ...(account.initialization_mibps ? { VolumeInitializationRate: account.initialization_mibps } : {}) } }],
    InstanceMarketOptions: { MarketType: 'spot', SpotOptions: { SpotInstanceType: 'one-time', InstanceInterruptionBehavior: 'terminate' } },
    InstanceInitiatedShutdownBehavior: 'terminate', MetadataOptions: { HttpTokens: 'required', HttpPutResponseHopLimit: 1, HttpEndpoint: 'enabled', HttpProtocolIpv6: 'disabled' },
    TagSpecifications: ['instance', 'volume'].map((ResourceType) => ({ ResourceType, Tags: resourceTags })), UserData: Buffer.from(userData).toString('base64') };
}
export function viewInstance(i, candidate, row) {
  const t = tagMap(i), alloc = t['ci-kit-alloc'];
  let savedPrice;
  try { savedPrice = JSON.parse(t['ci-kit-price']); } catch { /* old/fixture instance is unpriced without a row */ }
  const size = Number(t['ci-kit-cpus']);
  return { provider: 'ec2', id: i.InstanceId, alloc, runner: providerRunnerName('ec2', alloc), repo: t['ci-kit-repo']?.replace('--', '/'),
    size, labels: providerRunnerLabels('ec2', size), state: ({ pending: 'pending', running: 'running', stopping: 'stopping', stopped: 'stopped', 'shutting-down': 'gone', terminated: 'gone' })[i.State.Name],
    stateReason: i.StateReason?.Code, createdAt: iso(i.LaunchTime), candidate: { ...candidate,
      disk: { type: 'gp3', sizeGB: Number(t['ci-kit-disk-gb']) || row?.disk_gb || candidate.disk.sizeGB },
      price: row?.price ?? savedPrice ?? { source: 'unpriced', at: iso(i.LaunchTime) } } };
}
