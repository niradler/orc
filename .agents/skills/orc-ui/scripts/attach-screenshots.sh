#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 3 ]]; then
  printf 'Usage: %s <pr-number> <summary-text> <file#Alt-text> [<file#Alt-text> ...]\n' "$0" >&2
  exit 2
fi

PR_NUMBER="$1"
SUMMARY="$2"
shift 2

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
ATTACH_ARGS=()
LINES=()

for spec in "$@"; do
  file_path="${spec%%#*}"
  if [[ "$spec" == *"#"* ]]; then
    alt_text="${spec#*#}"
  else
    alt_text="$(basename "$file_path")"
  fi

  if [[ ! -f "$file_path" ]]; then
    printf 'Error: screenshot file not found: %s\n' "$file_path" >&2
    exit 1
  fi

  case "${file_path##*.}" in
    png|PNG|jpg|JPG|jpeg|JPEG|webp|WEBP) ;;
    *)
      printf 'Error: unsupported image extension for %s (expected png/jpg/webp)\n' "$file_path" >&2
      exit 1
      ;;
  esac

  if git -C "$ROOT" ls-files --error-unmatch "$file_path" >/dev/null 2>&1; then
    printf 'Error: %s is tracked in git. Never commit PR approval screenshots.\n' "$file_path" >&2
    exit 1
  fi

  dims=""
  if command -v sips >/dev/null 2>&1; then
    w="$(sips -g pixelWidth "$file_path" 2>/dev/null | awk '/pixelWidth/{print $2}')"
    h="$(sips -g pixelHeight "$file_path" 2>/dev/null | awk '/pixelHeight/{print $2}')"
    [[ -n "$w" && -n "$h" ]] && dims=" (${w}x${h})"
  fi

  LINES+=("- \`${alt_text}\`${dims}")
  ATTACH_ARGS+=(--attach "${file_path}#${alt_text}")
done

HEAD_SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
BODY="$(cat <<EOF
UI states for review at \`${HEAD_SHA}\` (demo data only — no real workspace data).

${SUMMARY}

$(printf '%s\n' "${LINES[@]}")

Nir: approving these desktop and phone states is the remaining UI gate.
EOF
)"

gh pr comment "$PR_NUMBER" --body "$BODY" "${ATTACH_ARGS[@]}"
