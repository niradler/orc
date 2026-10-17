type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
};

/**
 * `slugs` are the targets that resolve. Links accept any `[[Title]]`, `[[folder/file]]` or
 * `[[target|label]]` and match on {@link wikiLinkKey}.
 */
export type WikiLinks = { slugs: string[]; select: (slug: string) => void };

const LINK = /\[\[([^[\]|\n]+?)(?:\|([^[\]\n]+))?\]\]/g;

/** Same normalization as the server's link resolver: case/space-insensitive, `.md` optional. */
export function wikiLinkKey(target: string): string {
  return target.trim().replace(/\.md$/i, "").replace(/\s+/g, " ").toLowerCase();
}

/** Transform text nodes only, leaving code and existing links literal. */
export function remarkWikiLinks() {
  return (tree: MarkdownNode) => {
    function visit(parent: MarkdownNode): void {
      if (!parent.children || parent.type === "link") return;
      parent.children = parent.children.flatMap((node) => {
        if (node.type !== "text" || !node.value) {
          visit(node);
          return [node];
        }
        const parts: MarkdownNode[] = [];
        let offset = 0;
        for (const match of node.value.matchAll(LINK)) {
          if (match.index > offset)
            parts.push({
              type: "text",
              value: node.value.slice(offset, match.index),
            });
          parts.push({
            type: "link",
            url: `#wiki-${encodeURIComponent(match[1] ?? "")}`,
            children: [{ type: "text", value: (match[2] ?? match[1] ?? "").trim() }],
          });
          offset = match.index + match[0].length;
        }
        if (!parts.length) return [node];
        if (offset < node.value.length)
          parts.push({ type: "text", value: node.value.slice(offset) });
        return parts;
      });
    }
    visit(tree);
  };
}
