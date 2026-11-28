#!/usr/bin/env bash
# Says what the daily Paseo check found (see .github/workflows/paseo-compat.yml):
#   all well          → nothing new; an issue an earlier release opened is closed
#   only the range    → a PR that opens the declared range (one per release)
#   anything else     → an issue (one per release) and a red run
# Env: V (the Paseo version), GATE (gate.mjs's exit code), RANGE (the range it would accept),
# TYPES and TESTS (the steps' outcomes), GH_TOKEN; run from the repository root.
set -euo pipefail

label=paseo-compat
run_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}"
gh label create "$label" --color D93F0B --description "Found by the daily check against the newest Paseo" >/dev/null 2>&1 || true

if [[ "$GATE" == 0 && "$TYPES" == success && "$TESTS" == success ]]; then
  echo "hopkins works with Paseo $V."
  for n in $(gh issue list --label "$label" --state open --json number --jq '.[].number'); do
    gh issue close "$n" --comment "hopkins works with Paseo $V: $run_url"
  done
  exit 0
fi

if [[ "$GATE" == 2 && "$TYPES" == success && "$TESTS" == success && -n "$RANGE" ]]; then
  branch="compat/paseo-$V"
  if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
    echo "A PR for Paseo $V is open already ($branch)."
    exit 0
  fi
  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  git switch -c "$branch"
  RANGE="$RANGE" node -e '
    const fs = require("fs");
    const f = "paseo-plugin.json";
    const m = JSON.parse(fs.readFileSync(f, "utf8"));
    m.requirements.paseo = process.env.RANGE;
    fs.writeFileSync(f, JSON.stringify(m, null, 2) + "\n");'
  git commit -qam "Paseo $V: requirements.paseo $RANGE, so its apps and daemon load hopkins"
  git push -q origin "$branch"
  gh pr create --head "$branch" --label "$label" \
    --title "Paseo $V would drop hopkins: open the declared range to $RANGE" \
    --body "Paseo $V's own plugin gate refuses hopkins only because of \`requirements.paseo\`. With \`$RANGE\` it accepts it, and the typecheck and tests pass against Paseo $V's plugin packages.

The apps update themselves before the daemon does, so without this the sidebar entry and every hopkins screen vanish from an updated app.

Found by the daily check: $run_url"
  exit 0
fi

title="Paseo $V breaks hopkins"
if [[ -n "$(gh issue list --label "$label" --state open --search "in:title \"$title\"" --json number --jq '.[0].number // empty')" ]]; then
  echo "$title: the issue is open already."
  exit 1
fi
tail_of() { [[ -f "$1" ]] && { echo '```'; tail -n 60 "$1"; echo '```'; } || echo "(no log)"; }
{
  echo "The daily check ran hopkins against Paseo $V: $run_url"
  echo
  echo "- Plugin gate (daemon and apps): $( [[ "$GATE" == 0 ]] && echo accepted || cat gate.log 2>/dev/null | head -n 3 )"
  echo "- Typecheck against its plugin packages: $TYPES"
  echo "- Tests: $TESTS"
  if [[ "$TYPES" != success ]]; then echo; echo "Typecheck:"; tail_of types.log; fi
  if [[ "$TESTS" != success ]]; then echo; echo "Tests:"; tail_of tests.log; fi
  echo
  echo "Until it is fixed, keep the daemon on the last good Paseo; an app that updated past it may hide hopkins."
} > compat-issue.md
gh issue create --title "$title" --label "$label" --body-file compat-issue.md
exit 1
