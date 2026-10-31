import { useEffect, useState } from "react";

const KEY = "orc_folder_history";
const CHANGED = "orc-folder-history-changed";
type History = { last: string; recent: string[] };
export function folderHistory(host: string | null): History {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    const entry =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)[host === null ? "local" : `ssh:${host}`]
        : null;
    if (!entry || typeof entry !== "object") return { last: "", recent: [] };
    const recent =
      "recent" in entry && Array.isArray(entry.recent)
        ? entry.recent
            .filter(
              (path): path is string =>
                typeof path === "string" && path.length > 0 && path.length <= 4096,
            )
            .slice(0, 15)
        : [];
    return { last: "last" in entry && typeof entry.last === "string" ? entry.last : "", recent };
  } catch {
    return { last: "", recent: [] };
  }
}
export function rememberFolder(host: string | null, path: string) {
  path = path.trim();
  if (!path || path.length > 4096) return;
  try {
    const previous = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    const all =
      previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {};
    const recent = [path, ...folderHistory(host).recent.filter((item) => item !== path)].slice(
      0,
      15,
    );
    localStorage.setItem(
      KEY,
      JSON.stringify({ ...all, [host === null ? "local" : `ssh:${host}`]: { last: path, recent } }),
    );
    window.dispatchEvent(new Event(CHANGED));
  } catch {
    /* Folder selection still works without browser storage. */
  }
}
export function useFolderHistory(host: string | null) {
  const [history, setHistory] = useState(() => folderHistory(host));
  useEffect(() => {
    const refresh = () => setHistory(folderHistory(host));
    refresh();
    window.addEventListener(CHANGED, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(CHANGED, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [host]);
  return history;
}
