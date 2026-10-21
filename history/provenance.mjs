// Where a run line comes from (test history spec, Glossary and Design "Store"): the producer and label from the
// run's ref, the commit and tree it tested, and the change's previous run with what changed since. All of it is
// resolved at collection, while the refs and commits are still reachable.

// ci-kit's ci-gate pushes ci/<label>-<sha8>-<nonce6> (cli/naming.mjs); MAWS's scripts/ci-gate.sh pushes
// ci/<label>-<sha8>. The last segment's length tells them apart: six hex digits against eight.
const REFS = [
  { producer: 'ci-kit-ci-gate', re: /^ci\/(.+)-([0-9a-f]{8})-[0-9a-f]{6}$/ },
  { producer: 'maws-ci-gate', re: /^ci\/(.+)-([0-9a-f]{8})$/ },
];

// { producer, label, sha8 } of a run: a ci-gate producer for a push to a ref in its format, else `other` (a push
// to a branch, a dispatch, a schedule), whose label is null.
export function producerOf(run) {
  if (run.event === 'push') {
    for (const { producer, re } of REFS) {
      const m = re.exec(run.head_branch ?? '');
      if (m) return { producer, label: m[1], sha8: m[2] };
    }
  }
  return { producer: 'other', label: null, sha8: null };
}

// The gates a run was asked for: MAWS's `Gates:` trailer or ci-kit's `CI-Gates:`, as written; null without one.
export function gatesOf(message) {
  const m = /^(?:CI-)?Gates:[ \t]*(.*?)[ \t]*$/m.exec(message ?? '');
  return m ? m[1] : null;
}

// { producer, label, gates, tested, tree }. Both ci-gates push the tested commit with one empty commit on top, so
// the tested commit is the head's only parent, whose sha starts with the ref's sha8. A head that is not such a
// commit makes the run `other`: it tested its own head, and no change is guessed for it.
export async function resolveTested(gh, repo, run) {
  const head = await gh.gitCommit(repo, run.head_sha);
  const gates = gatesOf(head.message);
  const { producer, label, sha8 } = producerOf(run);
  const parent = head.parents?.length === 1 ? head.parents[0].sha : null;
  if (producer !== 'other' && parent?.startsWith(sha8)) {
    const tested = await gh.gitCommit(repo, parent);
    return { producer, label, gates, tested: parent, tree: tested.tree.sha };
  }
  return { producer: 'other', label: null, gates, tested: run.head_sha, tree: head.tree.sha };
}

const before = (a, b) =>
  a.started < b.started || (a.started === b.started && (a.run < b.run || (a.run === b.run && a.attempt < b.attempt)));

// Paths in a comparison: each file's name, and a rename's old name too.
const pathsOf = (files) => [...new Set(files.flatMap((f) => (f.previous_filename ? [f.previous_filename, f.filename] : [f.filename])))].sort();

// The change's previous run for a present line: among `lines`, the latest present line of the same job, producer and
// label that started before it and whose tested commit has the same tree or is an ancestor (the compare API reports
// this commit `ahead` of it). A candidate that is neither (a sibling, an amended commit) is passed over.
// → { run, attempt, relation, paths, truncated } or null:
//   - `same-tree`: paths [];
//   - `descendant`: the paths changed between them, `truncated` when the comparison lists its limit of 300 files;
//   - `unknown`: GitHub cannot compare them (a commit it no longer has), or `maxCompares` ran out first; the
//     candidate named is where the search stopped, and paths is null.
// A line with no label (producer `other`) has no change, so no previous run.
export async function previousRun(gh, repo, line, lines, { maxCompares = 10 } = {}) {
  if (line.label === null || line.report !== 'present') return null;
  const candidates = lines
    .filter((c) => c.report === 'present' && c.job === line.job && c.producer === line.producer && c.label === line.label && before(c, line))
    .sort((a, b) => (before(a, b) ? 1 : -1));
  let compares = 0;
  for (const c of candidates) {
    const at = { run: c.run, attempt: c.attempt };
    if (c.tree === line.tree) return { ...at, relation: 'same-tree', paths: [], truncated: false };
    if (compares === maxCompares) return { ...at, relation: 'unknown', paths: null, truncated: false };
    compares += 1;
    let cmp;
    try {
      cmp = await gh.compare(repo, c.tested, line.tested);
    } catch (err) {
      if (err.status === 404 || err.status === 422) return { ...at, relation: 'unknown', paths: null, truncated: false };
      throw err;
    }
    if (cmp.status === 'ahead') {
      const files = cmp.files ?? [];
      return { ...at, relation: 'descendant', paths: pathsOf(files), truncated: files.length >= 300 };
    }
  }
  return null;
}
