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
