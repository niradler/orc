#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
BASE="${1:-origin/master}"

errors=0
warnings=0

pass() { printf '[ok]   %s\n' "$1"; }
warn() { printf '[warn] %s\n' "$1"; warnings=$((warnings + 1)); }
fail() { printf '[fail] %s\n' "$1"; errors=$((errors + 1)); }

printf '=== ORC PR preflight (%s vs %s) ===\n' "$BRANCH" "$BASE"

if [[ "$BRANCH" == "master" || "$BRANCH" == "main" || "$BRANCH" == "HEAD" ]]; then
  fail "Current branch is '$BRANCH'. Create a feature branch in an allowed worktree."
else
  pass "Branch '$BRANCH' is not master/main."
fi

COMMON_DIR="$(git rev-parse --git-common-dir)"
if [[ "$COMMON_DIR" != ".git" && "$COMMON_DIR" != "$ROOT/.git" ]]; then
  case "$ROOT" in
    */.orc/worktrees/*|*/.claude/worktrees/*|*/.codex/worktrees/*)
      pass "Worktree path is in an allowed location: $ROOT"
      ;;
    *)
      fail "Worktree path '$ROOT' is outside allowed roots (.orc/worktrees, .claude/worktrees, ~/.codex/worktrees)."
      ;;
  esac
fi

if [[ -n "$(git status --porcelain)" ]]; then
  warn "Working tree has uncommitted changes (pre-push ci:pr requires a clean tree)."
else
  pass "Working tree is clean."
fi

if ! git rev-parse --verify "$BASE" >/dev/null 2>&1; then
  fail "Base ref '$BASE' not found. Run: git fetch origin master"
  exit 1
fi

CHANGED_FILES="$(git diff --name-only "$BASE...HEAD")"
if [[ -z "$CHANGED_FILES" ]]; then
  warn "No committed diff between $BASE and HEAD yet."
fi

EXAMPLES_NAMES=()
for dir in "$ROOT/.examples" "$ROOT/../.examples" "$(dirname "$(cd "$COMMON_DIR/.." && pwd)")/.examples" "$(cd "$COMMON_DIR/.." && pwd)/.examples"; do
  if [[ -d "$dir" ]]; then
    while IFS= read -r entry; do
      [[ -n "$entry" ]] && EXAMPLES_NAMES+=("$entry")
    done < <(find "$dir" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; 2>/dev/null || true)
  fi
done

if [[ ${#EXAMPLES_NAMES[@]} -gt 0 ]]; then
  UNIQUE_NAMES="$(printf '%s\n' "${EXAMPLES_NAMES[@]}" | sort -u)"
  LEAK_FOUND=0
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    if git diff "$BASE...HEAD" | rg -i --fixed-strings "$name" >/dev/null 2>&1 || \
       git log "$BASE..HEAD" --format=%B | rg -i --fixed-strings "$name" >/dev/null 2>&1; then
      fail "Branch diff or commit messages reference a local .examples folder name."
      LEAK_FOUND=1
    fi
  done <<< "$UNIQUE_NAMES"
  if [[ "$LEAK_FOUND" -eq 0 ]]; then
    pass "Zero local .examples reference names found in diff or commit messages."
  fi
fi

if printf '%s\n' "$CHANGED_FILES" | rg '^packages/api/src/routes/' >/dev/null 2>&1; then
  if printf '%s\n' "$CHANGED_FILES" | rg '^packages/sdk/src/openapi\.gen\.ts$' >/dev/null 2>&1; then
    pass "API routes changed and SDK OpenAPI types were updated."
  else
    warn "packages/api/src/routes/ changed without updating packages/sdk/src/openapi.gen.ts (run: bun run sdk:generate)."
  fi
fi

if printf '%s\n' "$CHANGED_FILES" | rg '^packages/web/src/' >/dev/null 2>&1; then
  warn "packages/web/src/ changed: complete orc-ui screenshot gate (desktop + phone via gh pr comment --attach)."
fi

COMMITTED_APPROVAL_SCREENS="$(printf '%s\n' "$CHANGED_FILES" | rg -i '(^|/)qa-screenshot|screenshot.*\.(png|jpg|jpeg|webp)$' | rg -v '^docs/public/screens/' || true)"
if [[ -n "$COMMITTED_APPROVAL_SCREENS" ]]; then
  fail "Approval screenshots appear committed in branch diff (attach via gh pr comment --attach instead): $COMMITTED_APPROVAL_SCREENS"
fi

NEW_DOC_SCREENS="$(printf '%s\n' "$CHANGED_FILES" | rg '^docs/public/screens/' || true)"
if [[ -n "$NEW_DOC_SCREENS" ]]; then
  while IFS= read -r img; do
    base_img="$(basename "$img")"
    if ! rg --fixed-strings "$base_img" "$ROOT/docs" --glob '!docs/public/screens/**' >/dev/null 2>&1; then
      fail "Unreferenced docs screenshot '$img' (no docs page links to $base_img)."
    fi
  done <<< "$NEW_DOC_SCREENS"
fi

if command -v node >/dev/null 2>&1; then
  NODE_VER="$(node -v | sed 's/^v//')"
  NODE_MAJOR="$(printf '%s' "$NODE_VER" | cut -d. -f1)"
  NODE_MINOR="$(printf '%s' "$NODE_VER" | cut -d. -f2)"
  if (( NODE_MAJOR < 22 || (NODE_MAJOR == 22 && NODE_MINOR < 19) )); then
    warn "node v$NODE_VER on PATH is < 22.19; packages/api/src/__tests__/pi-chat.test.ts requires Node >= 22.19."
  else
    pass "node v$NODE_VER satisfies Pi test requirement (>= 22.19)."
  fi
fi

printf '\n--- ci:pr plan ---\n'
(cd "$ROOT" && bun run ci:pr --plan)

printf '\nSummary: %d error(s), %d warning(s)\n' "$errors" "$warnings"
exit "$errors"
