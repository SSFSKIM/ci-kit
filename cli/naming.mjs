// The names and texts ci-gate builds and reads: the ci ref, the nonce commit's message, the repo from a remote,
// durations, and job logs.

export function sanitizeLabel(label) {
  const clean = (label ?? '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+|[.-]+$/g, '');
  return clean === '' ? 'gate' : clean;
}

// ci/<label>-<sha8>-<nonce6>: the nonce keeps concurrent calls on one commit and label on separate refs.
export function refName(label, sha, nonce) {
  return `ci/${label}-${sha.slice(0, 8)}-${nonce.slice(0, 6)}`;
}

// `ci-gate <12 hex>`, then the trailers after a blank line. Only CI-Gates is defined (spec I4).
export function nonceMessage(nonce, gates) {
  const subject = `ci-gate ${nonce}\n`;
  return gates.length > 0 ? `${subject}\nCI-Gates: ${gates.join(',')}\n` : subject;
}

export function parseGitHubRemote(url) {
  const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

// A job log as GitHub serves it, without the BOM, colour codes and per-line timestamps.
export function cleanLog(text) {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /gm, '');
}
