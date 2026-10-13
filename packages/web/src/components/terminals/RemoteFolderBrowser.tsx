import { useQuery } from "@tanstack/react-query";
import { ArrowUp, Folder } from "lucide-react";
import { useState } from "react";
import { api } from "@/api/client";

interface RemoteFolderBrowserProps {
  initial: string;
  onPick: (path: string) => void;
  onClose: () => void;
}

export function RemoteFolderBrowser({ initial, onPick, onClose }: RemoteFolderBrowserProps) {
  const [path, setPath] = useState(initial);
  const { data, error, isFetching } = useQuery({
    queryKey: ["terminals", "browse", path],
    queryFn: () => api.terminals.browse(path || undefined),
    retry: false,
  });
  const join = (name: string) => (data ? `${data.path.replace(/\/$/, "")}/${name}` : name);

  return (
    <div
      data-testid="remote-folder-browser"
      className="border border-surface-highest rounded-sm bg-surface-low p-1 space-y-1"
    >
      <div className="flex items-center gap-1 px-1">
        <button
          type="button"
          data-testid="remote-folder-up"
          disabled={!data?.parent}
          onClick={() => data?.parent && setPath(data.parent)}
          title="Parent folder"
          className="shrink-0 p-1 rounded-sm text-outline hover:bg-surface-highest hover:text-on-surface disabled:opacity-40"
        >
          <ArrowUp size={12} />
        </button>
        <span
          className="min-w-0 flex-1 truncate font-body text-[11px] text-on-surface"
          title={data?.path}
        >
          {data?.host ? `${data.host}:` : ""}
          {data?.path ?? path}
        </span>
      </div>
      {error && (
        <p className="px-1 font-body text-[11px] text-error break-words">
          {error instanceof Error ? error.message : String(error)}
        </p>
      )}
      <ul className="max-h-48 overflow-y-auto">
        {data?.directories.map((name) => (
          <li key={name}>
            <button
              type="button"
              data-testid="remote-folder-entry"
              onClick={() => setPath(join(name))}
              className="w-full flex items-center gap-1.5 px-1 py-0.5 rounded-sm font-body text-xs text-on-surface-variant hover:bg-surface-highest hover:text-on-surface"
            >
              <Folder size={11} className="shrink-0 text-outline" />
              <span className="truncate">{name}</span>
            </button>
          </li>
        ))}
        {data && data.directories.length === 0 && !isFetching && (
          <li className="px-1 py-0.5 font-body text-[11px] text-outline">No subfolders</li>
        )}
      </ul>
      <div className="flex justify-end gap-1 px-1">
        <button
          type="button"
          onClick={onClose}
          className="px-2 py-0.5 rounded-sm font-label text-[10px] uppercase tracking-widest text-outline hover:text-on-surface"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="remote-folder-pick"
          disabled={!data}
          onClick={() => data && onPick(data.path)}
          className="px-2 py-0.5 rounded-sm bg-primary/15 border border-primary/30 text-primary font-label text-[10px] uppercase tracking-widest hover:bg-primary/25 disabled:opacity-50"
        >
          Use folder
        </button>
      </div>
    </div>
  );
}
