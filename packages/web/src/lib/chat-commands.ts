export type CommandOption = {
  name: string;
  kind: "prompt" | "skill";
  title: string;
  description: string;
};

const MAX_OPTIONS = 50;

/** The `/word` being typed right before the caret, when it starts the draft or follows whitespace. */
export function activeCommand(draft: string, caret: number) {
  const match = /(^|\s)\/([^\s/]*(?:\/[^\s/]*)?)$/.exec(draft.slice(0, caret));
  if (!match) return null;
  const query = match[2] ?? "";
  return { query, start: caret - query.length - 1 };
}

/** Puts prefix matches first, then other name or description matches. */
export function rankCommands(options: CommandOption[], query: string): CommandOption[] {
  const q = query.toLowerCase();
  const scored = options.flatMap((option) => {
    const name = option.name.toLowerCase();
    const rank = name.startsWith(q)
      ? 0
      : name.includes(q)
        ? 1
        : option.description.toLowerCase().includes(q)
          ? 2
          : -1;
    return rank < 0 ? [] : [{ option, rank }];
  });
  return scored
    .sort((a, b) => a.rank - b.rank || a.option.name.localeCompare(b.option.name))
    .slice(0, MAX_OPTIONS)
    .map(({ option }) => option);
}

const COMMAND_TOKEN =
  /(^|\s)(\/[\p{L}\p{N}][\p{L}\p{N}_:-]*(?:\/[\p{L}\p{N}][\p{L}\p{N}_:-]*)?)(?=\s|$)/gu;

export type DraftSegment = { text: string; command: boolean };

/** Splits a draft so known `/name` commands can be highlighted; mirrors the server's matching. */
export function commandSegments(draft: string, names: ReadonlySet<string>): DraftSegment[] {
  const segments: DraftSegment[] = [];
  let last = 0;
  for (const match of draft.matchAll(COMMAND_TOKEN)) {
    const token = match[2] as string;
    if (!names.has(token.slice(1))) continue;
    const start = (match.index ?? 0) + (match[1] as string).length;
    if (start > last) segments.push({ text: draft.slice(last, start), command: false });
    segments.push({ text: token, command: true });
    last = start + token.length;
  }
  if (last < draft.length) segments.push({ text: draft.slice(last), command: false });
  return segments;
}
