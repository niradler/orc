type FolderProject = { id: string; scope?: string | null };

function normalized(path: string): string {
  const value =
    path
      .trim()
      .replace(/\\/g, "/")
      .replace(/^\/\/\?\/UNC\//i, "//")
      .replace(/^\/\/\?\//, "")
      .replace(/\/+$/, "") || "/";
  return /^[A-Za-z]:(?:\/|$)/.test(value) || value.startsWith("//") ? value.toLowerCase() : value;
}

/** The most specific folder owns a session; sibling prefixes must never match. */
export function projectForFolder<T extends FolderProject>(
  cwd: string | null | undefined,
  projects: readonly T[],
): T | undefined {
  if (!cwd?.trim()) return undefined;
  const path = normalized(cwd);
  return projects
    .filter((project) => {
      if (!project.scope?.trim()) return false;
      const root = normalized(project.scope);
      return path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
    })
    .sort(
      (left, right) =>
        normalized(right.scope as string).length - normalized(left.scope as string).length,
    )[0];
}
