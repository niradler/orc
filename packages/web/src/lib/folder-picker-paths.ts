export function joinFolderPath(parent: string, name: string): string {
  const windows = /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(parent);
  return `${parent.replace(windows ? /[\\/]+$/ : /\/+$/, "")}${windows ? "\\" : "/"}${name}`;
}

export function folderBreadcrumbs(path: string): { label: string; path: string }[] {
  const drive = /^([A-Za-z]:)[\\/]/.exec(path);
  const share = /^[\\/]{2}([^\\/]+)[\\/]([^\\/]+)(?:[\\/]|$)/.exec(path);
  const windows = !!drive || !!share;
  const root = drive
    ? `${drive[1]}\\`
    : share
      ? `\\\\${share[1]}\\${share[2]}\\`
      : path.startsWith("/")
        ? "/"
        : "";
  if (!root) return path ? [{ label: path, path }] : [];
  const prefixLength = drive ? drive[0].length : share ? share[0].length : 1;
  const parts = path
    .slice(prefixLength)
    .split(windows ? /[\\/]+/ : /\/+/)
    .filter(Boolean);
  const crumbs = [{ label: root, path: root }];
  for (const part of parts)
    crumbs.push({ label: part, path: joinFolderPath(crumbs[crumbs.length - 1].path, part) });
  return crumbs;
}
