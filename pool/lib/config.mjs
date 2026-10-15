// The pool config (spec I8): pool/config/pool.json in the kit, baked to /etc/ci-kit/pool.json. No secrets.
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const KEYS = ['repos', 'types', 'locations', 'poll_seconds', 'idle_runner_minutes', 'drain_minute', 'memory_gb_per_cpu', 'max_hours_per_day', 'ledger'];

const strings = (v) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s !== '');
const positive = (v) => Number.isInteger(v) && v > 0;

export function parsePoolConfig(text) {
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch {
    throw new Error('ci-kit: pool config is not JSON');
  }
  const errors = [];
  for (const key of Object.keys(cfg)) if (!KEYS.includes(key)) errors.push(`unknown key "${key}"`);
  if (!Array.isArray(cfg.repos)) errors.push('repos must be a list');
  (cfg.repos ?? []).forEach((r, i) => {
    if (typeof r?.repo !== 'string' || !REPO.test(r.repo)) errors.push(`repos[${i}].repo must be OWNER/NAME`);
    if (!strings(r?.workflows)) errors.push(`repos[${i}].workflows must be a non-empty list of workflow file names`);
  });
  for (const key of ['types', 'locations']) if (!strings(cfg[key])) errors.push(`${key} must be a non-empty list`);
  for (const key of ['poll_seconds', 'idle_runner_minutes', 'memory_gb_per_cpu', 'max_hours_per_day']) {
    if (!positive(cfg[key])) errors.push(`${key} must be a positive integer`);
  }
  if (!Number.isInteger(cfg.drain_minute) || cfg.drain_minute < 0 || cfg.drain_minute > 59) errors.push('drain_minute must be 0..59');
  if (typeof cfg.ledger?.repo !== 'string' || !REPO.test(cfg.ledger.repo) || typeof cfg.ledger?.issue_title !== 'string') {
    errors.push('ledger must be {"repo": "OWNER/NAME", "issue_title": "…"}');
  }
  if (errors.length) throw new Error(`ci-kit: pool config: ${errors.join('; ')}`);
  return cfg;
}
