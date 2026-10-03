export function fileChangeState(file: { index: string; working: string; original: string | null }) {
  const conflict = ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(file.index + file.working);
  const staged = !conflict && file.index !== " " && file.index !== "?";
  const working = conflict || file.working !== " ";
  const code = conflict
    ? "U"
    : file.original
      ? "R"
      : file.working !== " "
        ? file.working
        : file.index;
  const label =
    (
      {
        M: "Modified",
        A: "Added",
        D: "Deleted",
        R: "Renamed",
        C: "Copied",
        U: "Conflict",
        "?": "Untracked",
      } as Record<string, string>
    )[code] ?? "Changed";
  return { staged, working, conflict, label };
}
