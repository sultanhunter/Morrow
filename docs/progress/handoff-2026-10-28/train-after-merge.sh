#!/bin/bash
# After a merge-train PR merges: wait for main's foundation run on the merge commit,
# apply staging migrations (card E3), then wait for the staging deploy and rerun it
# once if it stopped on the schema-head race. Prints statuses only.
set -u
sha="$1"
repo=sultanhunter/Morrow
cd /Users/sultanibneusman/Desktop/Morrow || exit 1
git fetch -q origin && git checkout -q main && git merge -q --ff-only origin/main
[ "$(git rev-parse HEAD)" = "$sha" ] || { echo "main is not at $sha"; exit 1; }
find_run() { gh run list --repo $repo --branch main --workflow "$1" --limit 10 --json databaseId,headSha --jq ".[] | select(.headSha==\"$sha\") | .databaseId" | head -1; }
wait_run() { local id="$1" s; until s=$(gh run view "$id" --repo $repo --json status,conclusion --jq '.status+" "+(.conclusion//"")' 2>/dev/null); [ "${s%% *}" = "completed" ]; do sleep 15; done; echo "$s"; }
ci=""; until [ -n "$ci" ]; do ci=$(find_run "Morrow foundation"); [ -n "$ci" ] || sleep 10; done
cir=$(wait_run $ci); echo "main CI run $ci: $cir"
[ "$cir" = "completed success" ] || { echo "main CI not green; no migrate"; exit 1; }
PATH=/opt/homebrew/opt/node@24/bin:$PATH NODE_OPTIONS=--network-family-autoselection-attempt-timeout=3000 npm run -s staging:migrate 2>&1 | tail -3
dep=""; for i in $(seq 1 40); do dep=$(find_run "Deploy staging"); [ -n "$dep" ] && break; sleep 15; done
[ -n "$dep" ] || { echo "no deploy run found"; exit 1; }
r=$(wait_run $dep); echo "deploy run $dep: $r"
if [ "$r" != "completed success" ]; then
  code=$(gh run view $dep --repo $repo --log 2>/dev/null | grep -o '"code":"[A-Z_]*"' | tail -1)
  echo "deploy code: $code"
  if [ "$code" = '"code":"STAGING_SCHEMA_HEAD_MISMATCH"' ]; then
    gh run rerun $dep --repo $repo >/dev/null 2>&1; sleep 10
    echo "rerun: $(wait_run $dep)"
  fi
fi
gh run view $dep --repo $repo --log 2>/dev/null | grep -o '"outcome":"[a-z_]*","code":[^,]*' | tail -1
gh run view $dep --repo $repo --log 2>/dev/null | grep -o '"health":{"ready":[a-z]*' | tail -1
