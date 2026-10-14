import type { WikiPage } from "@orc/sdk/types";

export function noteKey(page: Pick<WikiPage, "slug" | "project_id">): string {
  return `${page.project_id ?? "global"}:${page.slug}`;
}

/** Notebook links use the same kebab-case [[slug]] syntax as the Markdown reader. */
export function noteLinks(content: string): string[] {
  let fence: { marker: string; length: number } | undefined;
  const prose = content
    .split(/\r?\n/)
    .filter((line) => {
      const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        if (
          delimiter &&
          delimiter[1][0] === fence.marker &&
          delimiter[1].length >= fence.length &&
          !delimiter[2].trim()
        )
          fence = undefined;
        return false;
      }
      if (delimiter) {
        fence = { marker: delimiter[1][0], length: delimiter[1].length };
        return false;
      }
      return true;
    })
    .join("\n")
    .replace(/(`+)[\s\S]*?\1(?!`)/g, "")
    .replace(/\[[^\]]*\]\([^)]*\)/g, "");
  return [
    ...new Set([...prose.matchAll(/\[\[([a-z0-9]+(?:-[a-z0-9]+)*)\]\]/g)].map((match) => match[1])),
  ];
}

export type NoteEdge = { from: string; to: string };

/** Input is the API's effective scoped notebook; project notes shadow global slugs. */
export function noteEdges(pages: WikiPage[]): NoteEdge[] {
  const edges: NoteEdge[] = [];
  for (const page of pages) {
    for (const slug of noteLinks(page.content)) {
      const target =
        pages.find((entry) => entry.slug === slug && entry.project_id === page.project_id) ??
        pages.find((entry) => entry.slug === slug && entry.project_id === null) ??
        pages.find((entry) => entry.slug === slug);
      if (target) edges.push({ from: noteKey(page), to: noteKey(target) });
    }
  }
  return edges;
}
