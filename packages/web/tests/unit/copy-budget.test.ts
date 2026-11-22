import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
// One short explanation per popover. Anything longer belongs in a collapsed
// detail or docs, not a hover/tap overlay.
const MAX_RUN = 260;
const MAX_TOTAL = 360;

/** Remove JSX tags, keeping their text content, without tripping over quoted comparisons. */
function stripTags(text: string): string {
  const blockTags = new Set(["p", "div", "li", "ul", "ol", "br", "section"]);
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "<") {
      out += text[i];
      i++;
      continue;
    }
    const name = /^<\/?\s*([A-Za-z][\w.]*)/.exec(text.slice(i))?.[1]?.toLowerCase() ?? "";
    let quote: string | null = null;
    i++;
    while (i < text.length) {
      const char = text[i];
      if (quote) {
        if (char === "\\") i++;
        else if (char === quote) quote = null;
      } else if (char === '"' || char === "'" || char === "`") {
        quote = char;
      } else if (char === ">") {
        i++;
        break;
      }
      i++;
    }
    out += blockTags.has(name) ? "\n" : " ";
  }
  return out;
}

/** Readable runs in a popover body: literal branches plus plain text between tags. */
export function readableRuns(block: string): { runs: string[]; literals: string[]; plain: string } {
  const body = stripTags(block);
  const runs: string[] = [];
  const literals: string[] = [];
  let plain = "";
  let plainTotal = "";
  let i = 0;
  while (i < body.length) {
    if (body[i] !== "{") {
      plain += body[i];
      i++;
      continue;
    }
    runs.push(plain);
    plainTotal += ` ${plain}`;
    plain = "";
    let depth = 0;
    let quote: string | null = null;
    let literal = "";
    i++;
    depth = 1;
    while (i < body.length && depth > 0) {
      const char = body[i];
      if (quote) {
        if (char === "\\") {
          literal += body[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (char === quote) {
          quote = null;
          i++;
          if (literal.trim()) {
            literals.push(literal);
            runs.push(literal);
          }
          literal = "";
          continue;
        }
        literal += char;
        i++;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") quote = char;
      else if (char === "{") depth++;
      else if (char === "}") depth--;
      i++;
    }
    if (literal.trim()) {
      literals.push(literal);
      runs.push(literal);
    }
  }
  runs.push(plain);
  plainTotal += ` ${plain}`;
  const normalize = (run: string) => run.replace(/\s+/g, " ").trim();
  return {
    runs: runs
      .flatMap((run) => run.split("\n"))
      .map(normalize)
      .filter(Boolean),
    literals: literals.map(normalize).filter(Boolean),
    plain: normalize(plainTotal),
  };
}

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

describe("help popover copy budget", () => {
  test("keeps every help popover short enough to scan", () => {
    const offenders: string[] = [];
    for (const file of tsxFiles(SRC)) {
      const source = readFileSync(file, "utf8");
      const blocks = source.matchAll(/<HelpPopover\b[\s\S]*?<\/HelpPopover>/g);
      for (const match of blocks) {
        const line = source.slice(0, match.index).split("\n").length;
        const { runs, literals, plain } = readableRuns(match[0]);
        const longest = runs.reduce((worst, run) => (run.length > worst.length ? run : worst), "");
        const longestLiteral = literals.reduce(
          (worst, run) => (run.length > worst.length ? run : worst),
          "",
        );
        const total = plain.length + longestLiteral.length;
        if (longest.length > MAX_RUN || total > MAX_TOTAL) {
          offenders.push(
            `${relative(REPO, file)}:${line} (${longest.length}/${total} chars) "${longest.slice(0, 80)}…"`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("flags a popover that exceeds the budget", () => {
    const block = `<HelpPopover label="sample" testId="sample">\n${"A long explanation. ".repeat(20)}\n</HelpPopover>`;
    const { runs } = readableRuns(block);
    const longest = Math.max(...runs.map((run) => run.length));
    expect(longest).toBeGreaterThan(MAX_RUN);
  });
});
