export function splitMarkdownFrontmatter(content: string): {
  body: string;
  metadata: string | null;
} {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(content);
  if (!match) return { body: content, metadata: null };
  return { body: content.slice(match[0].length), metadata: match[1] };
}

/**
 * Streamdown portals fullscreen diagrams and tables to <body>, outside any open dialog, so the
 * dialog must neither close on them nor on the Escape that closes them. index.css restores
 * their pointer events, which a modal dialog disables on <body>.
 */
const MARKDOWN_FULLSCREEN = '[data-streamdown$="-fullscreen"]';
export function keepMarkdownFullscreen(event: Event): void {
  if (event.target instanceof Element && event.target.closest(MARKDOWN_FULLSCREEN))
    event.preventDefault();
}

export function collapseExpandedDocument(event: KeyboardEvent): boolean {
  if (document.querySelector(MARKDOWN_FULLSCREEN)) {
    event.preventDefault();
    return true;
  }
  const button = document.querySelector<HTMLButtonElement>(
    '[data-document-expanded="true"] [data-testid="markdown-expand"]',
  );
  if (!button) return false;
  event.preventDefault();
  button.click();
  return true;
}
