/** Display only: never use these labels to resolve files or authorize filesystem access. */
export function displayPath(value: string | null | undefined): string {
  if (!value) return "";
  let path = value;
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path);
      path = decodeURIComponent(url.pathname);
      if (url.hostname) path = `//${url.hostname}${path}`;
      else if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
    } catch {
      return value;
    }
  }
  const windows =
    /^[A-Za-z]:/.test(path) ||
    path.startsWith("\\") ||
    (!path.startsWith("/") && path.includes("\\")) ||
    path.startsWith("//?/");
  if (windows) path = path.replace(/\\/g, "/");
  if (path.slice(0, 8).toUpperCase() === "//?/UNC/") path = `//${path.slice(8)}`;
  else if (path.startsWith("//?/")) path = path.slice(4);
  if (path === "/" || /^[A-Za-z]:\/$/.test(path)) return path;
  return path.replace(/\/+$/, "");
}

export function pathLabel(value: string | null | undefined, count = 1): string {
  const path = displayPath(value);
  if (!path || path === "/" || /^[A-Za-z]:\/$/.test(path) || /^file:/i.test(path)) return path;
  return path.split("/").filter(Boolean).slice(-Math.max(1, count)).join("/");
}
