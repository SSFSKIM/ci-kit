import { createHash } from 'node:crypto';
import { hasDeclaration } from '../plan/config.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const names = (list) => [...new Set(list)].sort();

// The image identity, shared by jobs, bakes and the stale check. Callers pass the validated/defaulted setup and
// the script's actual bytes; a missing script is an error, never an image that appears current.
export function setupHash(setup, scriptBytes) {
  if (!hasDeclaration(setup)) return 'none';
  if (setup.script && scriptBytes === undefined) throw new Error(`setup.script: missing bytes for ${setup.script}`);
  return sha256(JSON.stringify({
    apt: names(setup.apt), brew: names(setup.brew), cask: names(setup.cask),
    node: setup.node, pnpm: setup.pnpm, install: setup.install,
    script: setup.script, script_sha256: setup.script ? sha256(scriptBytes) : '',
  })).slice(0, 16);
}
