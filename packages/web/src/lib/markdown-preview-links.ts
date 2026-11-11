import { previewLink } from "@orc/core/desktop-preview";

const PREFIX = "#orc-preview-file=";
type MarkdownNode = {
  type: string;
  url?: string;
  alt?: string;
  value?: string;
  children?: MarkdownNode[];
};

export function previewFileDestination(href: string): string | null {
  if (!href.startsWith(PREFIX)) return null;
  try {
    return decodeURIComponent(href.slice(PREFIX.length));
  } catch {
    return null;
  }
}

/** File destinations become inert internal anchors before URL hardening runs. */
export function remarkPreviewFiles() {
  return (tree: MarkdownNode): void => {
    function visit(node: MarkdownNode): void {
      if (node.url && ["link", "definition", "image"].includes(node.type)) {
        const file = previewLink(node.url);
        const route =
          /^\/(?:activity|tasks|sessions|terminals|knowledge|settings|projects|jobs|scratchpad|rules|skills)(?:[/?#]|$)/.test(
            node.url,
          );
        if (file?.kind === "file" && !route) {
          try {
            node.url = PREFIX + encodeURIComponent(node.url);
          } catch {
            return;
          }
          if (node.type === "image") {
            node.type = "link";
            node.children = [{ type: "text", value: node.alt || "Open image" }];
          }
        }
      }
      for (const child of node.children ?? []) visit(child);
    }
    visit(tree);
  };
}
