export function splitMarkdownFrontmatter(content: string): {
  body: string;
  metadata: string | null;
} {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(content);
  if (!match) return { body: content, metadata: null };
  return { body: content.slice(match[0].length), metadata: match[1] };
}

export function collapseExpandedDocument(event: KeyboardEvent): boolean {
  const button = document.querySelector<HTMLButtonElement>(
    '[data-document-expanded="true"] [data-testid="markdown-expand"]',
  );
  if (!button) return false;
  event.preventDefault();
  button.click();
  return true;
}
