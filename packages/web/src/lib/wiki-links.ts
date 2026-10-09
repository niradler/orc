type MarkdownNode = { type: string; value?: string; url?: string; children?: MarkdownNode[] };

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
        for (const match of node.value.matchAll(/\[\[([a-z0-9]+(?:-[a-z0-9]+)*)\]\]/g)) {
          if (match.index > offset)
            parts.push({ type: "text", value: node.value.slice(offset, match.index) });
          parts.push({
            type: "link",
            url: `#wiki-${match[1]}`,
            children: [{ type: "text", value: match[1] }],
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
