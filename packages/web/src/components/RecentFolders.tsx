import { useFolderHistory } from "@/lib/folder-history";

export function RecentFolders({
  host,
  onPick,
  disabled = false,
}: {
  host: string | null;
  onPick: (path: string) => void;
  disabled?: boolean;
}) {
  const { recent } = useFolderHistory(host);
  return (
    <label className="block text-xs text-on-surface-variant">
      <span className="sr-only">Recent folders</span>
      <select
        data-testid="recent-folders"
        aria-label="Recent folders"
        value=""
        disabled={disabled || !recent.length}
        className="w-full min-h-11 sm:min-h-8 [@media(pointer:coarse)]:min-h-11 rounded-md border border-control-border bg-background px-2 text-sm"
        onChange={(event) => {
          if (event.target.value) onPick(event.target.value);
        }}
      >
        <option value="">
          {recent.length ? `Recent folders (${recent.length})` : "No recent folders"}
        </option>
        {recent.map((path) => (
          <option key={path} value={path}>
            {path}
          </option>
        ))}
      </select>
    </label>
  );
}
