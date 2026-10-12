/** Case- and width-insensitive tag set, so "API" and "api" never split one topic. */
export function normalizeTags(tags: string[]): string[] {
  return [
    ...new Set(tags.map((tag) => tag.normalize("NFKC").trim().toLowerCase()).filter(Boolean)),
  ];
}
