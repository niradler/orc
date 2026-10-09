import { ValidationError } from "@orc/core/errors";

type BraceFrame = { start: number; alternatives: number; product: number };
const maxExpansion = 256;

/** Bound the glob before QMD persists it or the recursive brace parser sees it. */
export function validateKnowledgePattern(pattern: string): void {
  if (!pattern.trim() || pattern.length > 1024)
    throw new ValidationError("Knowledge pattern must contain 1 to 1024 characters");
  const frames: BraceFrame[] = [{ start: -1, alternatives: 0, product: 1 }];
  let parentheses = 0;
  let inClass = false;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "\\") {
      index++;
      continue;
    }
    if (character === "[") inClass = true;
    if (character === "]") inClass = false;
    if (inClass) continue;
    if (character === "(") parentheses++;
    if (character === ")") parentheses = Math.max(0, parentheses - 1);
    if (character === "{") frames.push({ start: index, alternatives: 0, product: 1 });
    if (frames.length - 1 + parentheses > 8)
      throw new ValidationError("Knowledge pattern nesting must not exceed 8 levels");
    const frame = frames[frames.length - 1];
    if (!frame) continue;
    if (character === "," && frames.length > 1) {
      frame.alternatives += frame.product;
      frame.product = 1;
    }
    if (character === "}" && frames.length > 1) {
      const body = pattern.slice(frame.start + 1, index);
      let expansions = frame.alternatives + frame.product;
      if (body.includes("..")) {
        const range = /^(-?\d+|[a-zA-Z])\.\.(-?\d+|[a-zA-Z])(?:\.\.(-?\d+))?$/.exec(body);
        if (!range) throw new ValidationError("Knowledge pattern contains an unsupported range");
        const start = range[1] ?? "";
        const end = range[2] ?? "";
        const numeric = /^-?\d+$/.test(start) && /^-?\d+$/.test(end);
        if (!numeric && (!/^[a-zA-Z]$/.test(start) || !/^[a-zA-Z]$/.test(end)))
          throw new ValidationError("Knowledge pattern range endpoints must have matching types");
        const from = numeric ? Number(start) : start.charCodeAt(0);
        const to = numeric ? Number(end) : end.charCodeAt(0);
        const step = Math.abs(Number(range[3] ?? "1"));
        if (
          !Number.isSafeInteger(from) ||
          !Number.isSafeInteger(to) ||
          !Number.isSafeInteger(step) ||
          !step
        )
          throw new ValidationError(
            "Knowledge pattern range must use safe integers and a nonzero step",
          );
        expansions = Math.floor(Math.abs(to - from) / step) + 1;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) parent.product *= expansions;
    }
    if (frames.some((entry) => entry.product + entry.alternatives > maxExpansion))
      throw new ValidationError("Knowledge pattern must not expand to more than 256 alternatives");
  }
  if (frames.length > 1 || inClass)
    throw new ValidationError("Knowledge pattern contains an unclosed brace or character class");
}
