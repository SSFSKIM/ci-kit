#!/usr/bin/env bash
# ci-kit — SessionStart and SubagentStart hook. In a git worktree whose top level has .github/ci-kit.yml, it tells the
# session (or the subagent starting in it) how to verify a commit: with ci-gate, on GitHub, not by running the gates
# on this machine. Anywhere else it prints nothing. It never fails the session and makes no network call: one git
# call and a file test.
#
# SessionStart's plain stdout reaches the model as context, as doperpowers' kairos.sh relies on (at startup and again
# after a compaction; a resume's replay drops the duplicate). SubagentStart's plain stdout does not reach the model,
# so that event gets the same text as JSON additionalContext. The directory is the payload's cwd, else the hook's own.

input=""
[ -t 0 ] || input="$(cat)"

# The payload's string field $1, when its value holds no quote or backslash (else empty, and the caller falls back).
field() {
  printf '%s' "$input" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"\\\\]*\)\".*/\1/p" | head -n 1
}

dir="$(field cwd)"
{ [ -n "$dir" ] && [ -d "$dir" ]; } || dir="$PWD"
top="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)" || exit 0
[ -f "$top/.github/ci-kit.yml" ] || exit 0

root="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
IFS= read -r -d '' text <<EOF
ci-kit: this repo's gates (.github/ci-kit.yml) run on GitHub Actions, not on this machine. Verify a commit with \`ci-gate\` from its worktree, or \`ci-gate <sha>\`; \`--gates a,b\` runs only those gates, and \`ci-gate --help\` has the rest (this plugin's copy: $root/bin/ci-gate). It tests the committed HEAD, never uncommitted changes. It prints one line per gate as it finishes (PASS; FAIL with log=<path>, the failed gate's log saved on disk; SKIP; CANCEL; WAIT and THROTTLE while queued or rate-limited), then GREEN <run-url> (exit 0), RED <failed>/<total> <run-url> (exit 1) or ERROR <message> (exit 2, config or infrastructure). Do not run the gates' commands on this machine to verify a commit; one focused test file while iterating is fine.
EOF
text="${text%$'\n'}"

if [ "$(field hook_event_name)" = SubagentStart ]; then
  escaped="$(printf '%s' "$text" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk '{ printf "%s%s", (NR > 1 ? "\\n" : ""), $0 }')"
  printf '{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"%s"}}\n' "$escaped"
else
  printf '%s\n' "$text"
fi
exit 0
