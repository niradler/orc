export function trimString(s: string, maxLen?: number): string {
  const trimmed = s.trim();
  if (maxLen !== undefined && trimmed.length > maxLen) {
    return `${trimmed.slice(0, maxLen)}…`;
  }
  return trimmed;
}
