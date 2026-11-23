#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

printf '=== ORC repository maintenance audit ===\n'

printf '\n--- Disk space ---\n'
df -h "$ROOT" | awk 'NR==1 || NR==2'

printf '\n--- Worktrees ---\n'
MAIN_ROOT="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
MERGED_BRANCHES="$(git branch --merged origin/master 2>/dev/null | sed 's/^[*+ ]*//' || true)"
git worktree list --porcelain | awk '
  /^worktree / { path=substr($0, 10); branch="" }
  /^branch /   { branch=substr($0, 8); sub(/^refs\/heads\//, "", branch) }
  /^$/         { if (path != "") print path "\t" branch; path=""; branch="" }
  END          { if (path != "") print path "\t" branch }
' | while IFS=$'\t' read -r wt_path wt_branch; do
  status="ok"
  if [[ "$wt_path" != "$MAIN_ROOT" ]]; then
    case "$wt_path" in
      */.orc/worktrees/*|*/.claude/worktrees/*|*/.codex/worktrees/*) ;;
      *) status="WARN:outside-allowed-root" ;;
    esac
  fi
  merged=""
  if [[ -n "$wt_branch" && "$wt_branch" != "master" && "$wt_branch" != "main" ]]; then
    if printf '%s\n' "$MERGED_BRANCHES" | grep -Fx -- "$wt_branch" >/dev/null 2>&1; then
      merged=" [merged into origin/master]"
    fi
  fi
  printf '%-24s %s (%s)%s\n' "[$status]" "$wt_path" "${wt_branch:-detached}" "$merged"
done

printf '\n--- Orphan docs/public/screens/ audit ---\n'
orphans=0
if [[ -d docs/public/screens ]]; then
  for img in docs/public/screens/*; do
    [[ -f "$img" ]] || continue
    base="$(basename "$img")"
    if ! rg --fixed-strings "$base" docs --glob '!docs/public/screens/**' >/dev/null 2>&1; then
      printf '[WARN] Unreferenced screenshot: %s\n' "$img"
      orphans=$((orphans + 1))
    fi
  done
fi
if [[ "$orphans" -eq 0 ]]; then
  printf '[OK]   All docs/public/screens/ images are referenced.\n'
fi

printf '\n--- Workspace version alignment ---\n'
bun -e '
import { readdirSync, readFileSync } from "node:fs";
const rootPkg = JSON.parse(readFileSync("package.json", "utf8"));
const expected = rootPkg.version;
let drift = 0;
for (const dir of readdirSync("packages", { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
  const pkg = JSON.parse(readFileSync(`packages/${dir}/package.json`, "utf8"));
  if (pkg.version && pkg.version !== expected) {
    console.log(`[WARN] packages/${dir} (${pkg.name}) is ${pkg.version}, root is ${expected}`);
    drift++;
  }
}
if (drift === 0) console.log(`[OK]   All workspace packages aligned at v${expected}.`);
'

printf '\n--- Local artifact footprint ---\n'
for path in .orc/worktrees packages/web/test-results packages/web/playwright-report output/playwright; do
  if [[ -e "$path" ]]; then
    du -sh "$path" 2>/dev/null || true
  fi
done
