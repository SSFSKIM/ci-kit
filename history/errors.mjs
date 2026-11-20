// What an error may say in a public log (the collector's and the preflight's run in Actions, and the repositories they
// read may be private): GitHub's status and the request this kit made, never the body GitHub answered with; a
// message this kit wrote (`history:` or `junit:`, naming runs, jobs, counts and offsets only); else the error's kind
// and a system error's code (ENOSPC), since any other message can quote what it failed on (a JSON parse error quotes
// the text, a git error its stderr).
import { BudgetSpent, GitHubError, isRateLimited } from '../lib/github.mjs';

export function describeError(err) {
  if (err instanceof GitHubError) {
    const request = err.method && err.path ? ` ${err.method} ${err.path.split('?')[0]}` : '';
    return isRateLimited(err) ? `HTTP ${err.status} (rate limited)` : `HTTP ${err.status}${request}`;
  }
  if (err instanceof BudgetSpent) return 'the call budget is spent';
  if (/^(history|junit): /.test(err?.message ?? '')) return err.message;
  const kind = /^[A-Za-z]+$/.test(err?.name ?? '') ? err.name : 'Error';
  return /^E[A-Z0-9]+$/.test(err?.code ?? '') ? `${kind} ${err.code}` : kind;
}
