// Billing is immutable, lifetime state, not a counter on the rotating allocation ledger.
const MARK = 'ci-kit-ec2-credit';
const day = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;

export function parseReading(body) {
  try {
    const json = new RegExp(`<!-- ${MARK} (.+?) -->`).exec(body)?.[1] ?? body;
    const r = JSON.parse(json);
    if (r?.v !== 1 || !day(r.since) || !day(r.through) || r.through <= r.since ||
        !Number.isFinite(r.billed_usd) || r.billed_usd < 0 || typeof r.read_at !== 'string' ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(r.read_at) || !day(r.read_at.slice(0, 10)) ||
        !Number.isFinite(Date.parse(r.read_at))) return null;
    return { v: 1, since: r.since, billed_usd: r.billed_usd, through: r.through, read_at: r.read_at };
  } catch { return null; }
}

export function renderReading(reading) {
  const r = parseReading(JSON.stringify(reading));
  if (!r) throw new Error('invalid billing reading');
  return `<!-- ${MARK} ${JSON.stringify(r)} -->\nAWS gross EC2 billing: $${r.billed_usd.toFixed(4)}, ${r.since} → ${r.through} (exclusive); read ${r.read_at}.`;
}

export function createBillingStore(gh, { repo, account }) {
  const title = `ec2 credit ${account}`;
  const opened = new Map();
  async function issues() {
    // Closed credit issues remain authoritative too. Unlike allocation issues these never rotate.
    const listed = [...await gh.openIssues(repo), ...await gh.closedIssuesSince(repo, '1970-01-01T00:00:00Z')]
      .filter(i => !i.pull_request && i.title === title);
    for (const i of listed) opened.delete(i.number);
    return [...listed, ...opened.values()].sort((a, b) => a.number - b.number);
  }
  async function comments(list) {
    return (await Promise.all(list.map(i => gh.issueComments(repo, i.number)))).flat();
  }
  const ordered = (list) => list.map(c => ({ c, r: parseReading(c.body) })).filter(x => x.r)
    .sort((a, b) => Date.parse(b.r.read_at) - Date.parse(a.r.read_at) || b.c.id - a.c.id);
  return {
    async read(since) {
      return ordered(await comments(await issues())).find(x => x.r.since === since)?.r ?? null;
    },
    async append(reading) {
      const body = renderReading(reading);
      const list = await issues();
      if (!list.length) {
        const made = await gh.createIssue(repo, { title, body: 'Immutable AWS billing readings for this account. The launcher retains the newest 20; this issue never rotates.' });
        opened.set(made.number, made);
        list.push(made);
      }
      const made = await gh.createComment(repo, list[0].number, body);
      // Include the successful write even if GitHub's list has not caught up. A concurrent stale list can
      // temporarily retain extras, but cannot delete a newer reading to keep an older one.
      const all = await comments(list);
      if (!all.some(c => c.id === made.id)) all.push(made);
      for (const { c } of ordered(all).slice(20)) await gh.deleteComment(repo, c.id).catch(err => {
        if (err.status !== 404) throw err; // a concurrent writer may have pruned it already
      });
    },
  };
}
