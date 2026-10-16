// Alerts (spec §3 Guard): issues labelled ci-kit-alert in the ledger repo (private, so MAWS activity does not leak
// through the public kit). One open issue per title: an alert already open is not opened again.
export const ALERT_LABEL = 'ci-kit-alert';

export function createAlerts(gh, repo, { log = () => {} } = {}) {
  let open = null;
  return async function alert({ title, body }) {
    open ??= (await gh.openIssues(repo, ALERT_LABEL)).filter((i) => !i.pull_request).map((i) => i.title);
    if (open.includes(title)) return log(`alert already open: ${title}`);
    await gh.ensureLabel(repo, ALERT_LABEL, 'd73a4a');
    await gh.createIssue(repo, { title, body, labels: [ALERT_LABEL] });
    open.push(title);
    log(`alert opened: ${title}`);
  };
}
