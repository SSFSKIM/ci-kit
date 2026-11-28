// The container contract shared by ephemeral GCE and EC2 job VMs.
import { jobEnvironmentArgs, workDir, IMAGE } from '../agent/docker.mjs';

export const SMOKE_SCRIPT = '/opt/ci-kit/gce/vm/smoke.sh';
// GCE resolves DNS at this address. All other TCP/UDP metadata traffic is denied in Docker's host-owned chain.
// EC2 additionally requires IMDSv2 with hop limit 1 and disables metadata IPv6 at launch.
export const METADATA_BLOCK = ['tcp', 'udp'].map((proto) => ['DOCKER-USER', '-d', '169.254.169.254/32', '-p', proto, '!', '--dport', '53', '-j', 'DROP']);

// The VM's placement as its metadata reads arrive: {field: promise of a value} → an object each read fills in when it
// resolves to a value; one that fails or never settles leaves its field out. Started beside the boot work, read when the
// container starts, so a slow metadata endpoint costs the job nothing.
export function arrivingPlacement(reads) {
  const placement = {};
  for (const [field, value] of Object.entries(reads)) {
    Promise.resolve(value).then((v) => { if (v) placement[field] = v; }, () => {});
  }
  return placement;
}

// placement: the VM's {machine, provisioning ('spot'|'standard'), zone}, as its cloud's metadata says; the job-started
// hook prints it in the job's log and summary, so a job's page says what it ran on. A field the VM could not read is
// left out.
export function jobRunArgs({ name, cpus, smoke, image = IMAGE, placement = {} }) {
  const said = { CI_KIT_MACHINE: placement.machine, CI_KIT_PROVISIONING: placement.provisioning, CI_KIT_ZONE: placement.zone };
  return [
    'run', '--rm', '--name', name,
    '-e', `CI_KIT_CORES=0-${cpus - 1}`,
    ...Object.entries(said).filter(([, v]) => /^[a-z0-9.-]+$/.test(v ?? '')).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    ...jobEnvironmentArgs(),
    ...(smoke
      ? ['-e', `CI_KIT_EXPECT_CPUS=${smoke.expectCpus}`, '-e', `CI_KIT_WORK=${workDir(name)}`,
        '-v', `${SMOKE_SCRIPT}:/usr/local/bin/ci-kit-smoke:ro`, '--entrypoint', '/usr/local/bin/ci-kit-smoke']
      : []),
    image,
  ];
}

export function smokeVerdict(output, exitCode) {
  const lines = output.split('\n').map((l) => l.match(/^ci-kit smoke: (ok|failed:[a-z0-9-]+)$/)).filter(Boolean);
  const verdict = lines.at(-1)?.[1];
  if (verdict?.startsWith('failed:')) return verdict;
  if (verdict === 'ok' && exitCode === 0) return 'ok';
  return `failed:container-exit-${exitCode}`;
}
