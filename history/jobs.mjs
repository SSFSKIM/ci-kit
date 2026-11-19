// The gate ledger's job lines and gate attempts (gate ledger spec, "A job line", Glossary "Gate", "Gate attempt",
// "Scope", "Tree basis", "Change", "Lane"): pure functions of a run, one attempt's jobs and the repository's entry in
// history/repos.json.

// The platform's own messages about a job, by kind (spec, "A job line": `annotations`). A message is kept as its kind,
// never as its text.
const PLATFORM = [
  ['not-started', /\bjob was not started because\b/i],
  ['runner-lost', /\blost communication with the server\b|\breceived a shutdown signal\b/i],
  ['time-limit', /\bexceeded the maximum execution time\b/i],
];
export const platformKind = (message) => PLATFORM.find(([, re]) => re.test(message ?? ''))?.[0] ?? null;
