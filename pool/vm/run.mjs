// The container contract shared by ephemeral GCE and EC2 job VMs.
import { jobEnvironmentArgs, workDir, IMAGE } from '../agent/docker.mjs';

export const SMOKE_SCRIPT = '/opt/ci-kit/gce/vm/smoke.sh';
// GCE resolves DNS at this address. All other TCP/UDP metadata traffic is denied in Docker's host-owned chain.
// EC2 additionally requires IMDSv2 with hop limit 1 and disables metadata IPv6 at launch.
export const METADATA_BLOCK = ['tcp', 'udp'].map((proto) => ['DOCKER-USER', '-d', '169.254.169.254/32', '-p', proto, '!', '--dport', '53', '-j', 'DROP']);

export function jobRunArgs({ name, cpus, smoke }) {
  return [
    'run', '--rm', '--name', name,
    '-e', `CI_KIT_CORES=0-${cpus - 1}`,
    ...jobEnvironmentArgs(),
    ...(smoke
      ? ['-e', `CI_KIT_EXPECT_CPUS=${smoke.expectCpus}`, '-e', `CI_KIT_WORK=${workDir(name)}`,
        '-v', `${SMOKE_SCRIPT}:/usr/local/bin/ci-kit-smoke:ro`, '--entrypoint', '/usr/local/bin/ci-kit-smoke']
      : []),
    IMAGE,
  ];
}

export function smokeVerdict(output, exitCode) {
  const lines = output.split('\n').map((l) => l.match(/^ci-kit smoke: (ok|failed:[a-z0-9-]+)$/)).filter(Boolean);
  const verdict = lines.at(-1)?.[1];
  if (verdict?.startsWith('failed:')) return verdict;
  if (verdict === 'ok' && exitCode === 0) return 'ok';
  return `failed:container-exit-${exitCode}`;
}
