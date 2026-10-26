// Dependency-free so callers don't pull the CodeMirror language packs into their chunk.
export function isMarkdownFile(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}
