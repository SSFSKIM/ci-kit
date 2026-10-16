// The ledger issue (spec I9) on GitHub: found by title (created if missing), one comment per server session.
// A write never moves a row back (running → deleting → final). Concurrent writers can each create a comment for
// the same server; after writing, a writer re-reads and deletes every comment for that server except the one all
// readers count (the most final, then the oldest), so both writers converge on the same survivor.
import { renderRow, rowComment, extraRowComments, rowsOf, renderSummary, lastSummaryAt, parseRow, moreFinal } from './ledger.mjs';

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

  async function deleteExtras(serverId) {
    for (const extra of extraRowComments(await comments(), serverId)) {
      await gh.deleteComment(repo, extra.id).catch((err) => {
        if (err.status !== 404) throw err; // the other writer removed it first
      });
    }
  }

  return {
    comments,
    rows: async () => rowsOf(await comments()),
    summaryAt: async () => lastSummaryAt(await comments()),
    async upsertRow(row) {
      const all = await comments();
      const existing = rowComment(all, row.server);
      const extras = extraRowComments(all, row.server);
      if (!existing) await gh.createComment(repo, await issue(), renderRow(row));
      else if (!moreFinal(parseRow(existing.body), row)) await gh.updateComment(repo, existing.id, renderRow(row));
      // Two writers that both found no row each created one: re-read, and keep the one every reader counts.
      if (!existing || extras.length) await deleteExtras(row.server);
    },
    async postSummary(summary) {
      await gh.createComment(repo, await issue(), renderSummary(summary));
    },
  };
}
