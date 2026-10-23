// The GCE metadata mode; the container and smoke contract is shared with EC2.
export { jobRunArgs, smokeVerdict, METADATA_BLOCK, SMOKE_SCRIPT } from '../../pool/vm/run.mjs';

export function vmMode({ jit, smoke }) {
  if (jit) return { kind: 'job' };
  if (/^[1-9][0-9]*$/.test(smoke ?? '')) return { kind: 'smoke', expectCpus: Number(smoke) };
  return { kind: 'none' };
}
