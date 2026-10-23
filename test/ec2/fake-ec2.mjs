import { createProvider } from '../../gce/launcher/providers/ec2.mjs';
export const start = Date.parse('2026-10-23T12:00:00Z');
export const account = { account: '290475840169', region: 'us-east-2', disk_gb: 50, initialization_mibps: 200,
  report_bucket: 'reports-example', security_group: 'sg-123',
  placements: [{ zone: 'us-east-2c', subnet: 'subnet-123', machines: { 2: 'c8a.large', 4: 'c8a.xlarge', 8: 'c8a.2xlarge', 16: 'c8a.4xlarge' } }] };
const tags = (x) => Object.entries(x).map(([Key, Value]) => ({ Key, Value: String(Value) }));
const image = { ImageId: 'ami-123', State: 'available', CreationDate: '2026-10-23T11:00:00Z', RootDeviceName: '/dev/sda1',
  Tags: tags({ 'ci-kit-pool': 'ec2', 'ci-kit-ready': 'true', 'ci-kit-commit': 'abc123', 'ci-kit-snapshot-gib': '11.46' }) };
export function fixture() {
  let time = start;
  const calls = [], logs = [], objects = new Map(), instances = [];
  const handlers = {
    DescribeInstances: () => ({ Reservations: [{ Instances: instances }] }),
    DescribeImages: () => ({ Images: [image] }),
    DescribeInstanceTypes: () => ({ InstanceTypes: [2, 4, 8, 16].map((n) => ({ InstanceType: account.placements[0].machines[n], VCpuInfo: { DefaultVCpus: n }, MemoryInfo: { SizeInMiB: n * 2048 }, ProcessorInfo: { SupportedArchitectures: ['x86_64'] } })) }),
    DescribeAvailabilityZones: () => ({ AvailabilityZones: [{ ZoneName: 'us-east-2c', ZoneId: 'use2-az3', State: 'available' }] }),
    DescribeSpotPriceHistory: () => ({ SpotPriceHistory: [2, 4, 8, 16].map((n) => ({ InstanceType: account.placements[0].machines[n], AvailabilityZone: 'us-east-2c', SpotPrice: '0.12', Timestamp: new Date(start) })) }),
    DescribeVolumes: () => ({ Volumes: [] }),
    RunInstances: () => ({ Instances: [{ InstanceId: 'i-123' }] }),
    TerminateInstances: () => ({}), DeleteVolume: () => ({}),
    GetObject: ({ Key }) => { if (!objects.has(Key)) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' }); return { Body: { transformToString: async () => JSON.stringify(objects.get(Key)) } }; },
  };
  const send = async (command) => { const name = command.constructor.name.replace(/Command$/, ''); calls.push([name, command.input]); return handlers[name](command.input); };
  const aws = { ec2: { send }, s3: { send }, presignPut: async ({ key }) => `https://example.com/${key}?signature=secret` };
  const make = (cfg = account) => createProvider({ aws, account: cfg, cfg: { max_run_minutes: 120 }, now: () => time, log: (line) => logs.push(line) });
  const provider = make();
  const row = { alloc: 'alloc1', repo: 'SSFSKIM/ci-kit-sandbox', cpus: 8, image: image.ImageId, zone: 'us-east-2c', client_token: 'alloc1-1', sent_at: new Date(start).toISOString() };
  return { aws, calls, logs, handlers, instances, objects, provider, make, row, advance: (ms) => { time += ms; } };
}
export async function prepared(f) { await f.provider.observe(); await f.provider.readyImage(); return f.provider.candidates(account, 8)[0]; }
export function instance(extra = {}) { return { InstanceId: 'i-123', InstanceType: 'c8a.2xlarge', ImageId: 'ami-123', LaunchTime: new Date(start), State: { Name: 'running' }, Placement: { AvailabilityZone: 'us-east-2c' }, SubnetId: 'subnet-123', InstanceLifecycle: 'spot', Tags: tags({ 'ci-kit-pool': 'ec2', 'ci-kit-purpose': 'job', 'ci-kit-alloc': 'alloc1', 'ci-kit-repo': 'SSFSKIM--ci-kit-sandbox', 'ci-kit-cpus': 8 }), ...extra }; }

