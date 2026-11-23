#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  printf 'Usage: %s <pr-number>\n' "$0" >&2
  exit 2
fi

PR="$1"
ROOT="$(git rev-parse --show-toplevel)"
COMMON_DIR="$(git rev-parse --git-common-dir)"

PR_JSON="$(gh pr view "$PR" --json number,title,body,isDraft,headRefName,headRefOid,baseRefName,files,statusCheckRollup,comments,url)"

PR_JSON="$PR_JSON" bun -e '
const pr = JSON.parse(process.env.PR_JSON || "{}");
const bodyLines = (pr.body || "").split(/\r?\n/).length;
const files = (pr.files || []).map((f) => f.path);
const checks = pr.statusCheckRollup || [];
const comments = pr.comments || [];

console.log(`=== PR #${pr.number}: ${pr.title} ===`);
console.log(`URL:    ${pr.url}`);
console.log(`Branch: ${pr.headRefName} -> ${pr.baseRefName}`);
console.log(`Head:   ${pr.headRefOid}`);
console.log(`Draft:  ${pr.isDraft ? "YES (violation: must be ready)" : "no"}`);
console.log(`Title:  ${/^[a-z]+(\([^)]+\))?: .+/.test(pr.title || "") ? "ok (type(scope): subject)" : "WARN (expected type(scope): subject)"}`);
console.log(`Body:   ${bodyLines} lines ${bodyLines > 40 ? "(WARN: > 40 lines)" : "(ok <= 40)"}`);

console.log("\n--- CI checks ---");
if (checks.length === 0) {
  console.log("(none reported on PR head)");
} else {
  for (const c of checks) {
    const name = c.name || c.context || "check";
    const status = c.conclusion || c.state || c.status || "unknown";
    console.log(`- ${name}: ${status}`);
  }
}

console.log(`\n--- Changed files (${files.length}) ---`);
for (const f of files) console.log(`- ${f}`);

const apiRoutesChanged = files.some((f) => f.startsWith("packages/api/src/routes/"));
const sdkUpdated = files.includes("packages/sdk/src/openapi.gen.ts");
const webSrcChanged = files.some((f) => f.startsWith("packages/web/src/"));
const committedScreens = files.filter((f) => /\.(png|jpe?g|webp)$/i.test(f) && !f.startsWith("docs/public/screens/"));
const imageComments = comments.filter((c) => /!\[[^\]]*\]\([^)]+\)|user-attachments\/assets/.test(c.body || ""));

console.log("\n--- Automated audit flags ---");
if (apiRoutesChanged && !sdkUpdated) console.log("[WARN] API routes changed without packages/sdk/src/openapi.gen.ts");
if (committedScreens.length > 0) console.log(`[FAIL] Committed screenshots outside docs/public/screens/: ${committedScreens.join(", ")}`);
if (webSrcChanged) {
  console.log(imageComments.length > 0
    ? `[OK]   Web UI changed and ${imageComments.length} comment(s) include attached screenshots`
    : "[WARN] Web UI changed but no screenshot comments found yet");
}
'

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
  PR_DIFF="$(gh pr diff "$PR" 2>/dev/null || true)"
  PR_TEXT="$(printf '%s\n%s' "$PR_JSON" "$PR_DIFF")"
  LEAK=0
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    if printf '%s' "$PR_TEXT" | rg -i --fixed-strings "$name" >/dev/null 2>&1; then
      printf '[FAIL] PR diff or metadata references a local .examples folder name.\n'
      LEAK=1
    fi
  done <<< "$UNIQUE_NAMES"
  if [[ "$LEAK" -eq 0 ]]; then
    printf '[OK]   Zero local .examples reference names found in PR diff/metadata.\n'
  fi
fi
