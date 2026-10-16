// The GCE job VM's pure parts (spec §3a Shape, VM lifecycle step 3): the job container's arguments, the metadata
// block, the VM's mode, and the smoke check's verdict. gce/vm/job.mjs runs them.
import { jobEnvironmentArgs, workDir, IMAGE } from '../../pool/agent/docker.mjs';

export const SMOKE_SCRIPT = '/opt/ci-kit/gce/vm/smoke.sh';

// The container's traffic to the metadata server, which holds the JIT config, is dropped, except DNS: GCE's resolver
// is the same address, port 53. Everything else is dropped, not only HTTP on 80, so no other endpoint the server
// may open is in reach. Rules go in DOCKER-USER, the chain Docker leaves to the host for container traffic.
export const METADATA_BLOCK = ['tcp', 'udp'].map((proto) => ['DOCKER-USER', '-d', '169.254.169.254/32', '-p', proto, '!', '--dport', '53', '-j', 'DROP']);

// One container on the whole VM: every vCPU (nproc is N because the VM has N), no memory cap beyond the VM's own,
// and the environment a Hetzner job container gets. The smoke check runs the check script in place of the runner.
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

// From the VM's metadata: a JIT config (ci-kit-jit, set by the launcher) means a job; ci-kit-smoke (set by the bake:
// the vCPUs the VM has) means the smoke check; neither means there is nothing to do.
export function vmMode({ jit, smoke }) {
  if (jit) return { kind: 'job' };
  if (/^[1-9][0-9]*$/.test(smoke ?? '')) return { kind: 'smoke', expectCpus: Number(smoke) };
  return { kind: 'none' };
}

// The check script ends with `ci-kit smoke: ok` or `ci-kit smoke: failed:<check>`. Only an ok with exit 0 passes.
export function smokeVerdict(output, exitCode) {
  const lines = output.split('\n').map((l) => l.match(/^ci-kit smoke: (ok|failed:[a-z0-9-]+)$/)).filter(Boolean);
  const verdict = lines.at(-1)?.[1];
  if (verdict?.startsWith('failed:')) return verdict;
  if (verdict === 'ok' && exitCode === 0) return 'ok';
  return `failed:container-exit-${exitCode}`;
}
