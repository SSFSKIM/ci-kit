// The ledger issue (spec I9) on GitHub: found by title (created if missing), one comment per server session.
import { renderRow, rowComment, rowsOf, renderSummary, lastSummaryAt } from './ledger.mjs';

export function createLedgerStore(gh, { repo, issue_title: title }) {
  let number = null;

  async function issue() {
    if (number !== null) return number;
    const found = (await gh.openIssues(repo)).find((i) => !i.pull_request && i.title === title);
    number = found
      ? found.number
      : (await gh.createIssue(repo, { title, body: 'One comment per ci-kit pool server session (spec I9), and a weekly cost summary from the guard.' })).number;
    return number;
  }

  const comments = async () => gh.issueComments(repo, await issue());

  return {
    comments,
    rows: async () => rowsOf(await comments()),
    summaryAt: async () => lastSummaryAt(await comments()),
    // At most one comment per server id: an existing one is rewritten in place.
    async upsertRow(row) {
      const existing = rowComment(await comments(), row.server);
      if (existing) await gh.updateComment(repo, existing.id, renderRow(row));
      else await gh.createComment(repo, await issue(), renderRow(row));
    },
    async postSummary(summary) {
      await gh.createComment(repo, await issue(), renderSummary(summary));
    },
  };
}
