import { parseMarkdownIntoBlocks } from "streamdown";

/**
 * Splits a running answer at top-level block boundaries so settled blocks can be
 * memoized while the tail grows. streamdown's splitter owns the hard cases: a
 * fenced code block, display math and an ordered list with blank lines stay
 * whole, and the blocks concatenate back to the exact input. Called only for a
 * live message; finished output renders as one markdown document.
 */
export function splitStreamingMarkdown(text: string): string[] {
  if (!text.trim()) return [];
  return parseMarkdownIntoBlocks(text);
}
