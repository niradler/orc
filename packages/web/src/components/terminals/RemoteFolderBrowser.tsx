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
      className="border border-surface-highest rounded-md bg-surface-low p-1 space-y-1"
    >
      <div className="flex items-center gap-1 px-1">
        <button
          type="button"
          data-testid="remote-folder-up"
          disabled={!data?.parent}
          onClick={() => data?.parent && setPath(data.parent)}
          aria-label="Parent folder"
          title="Parent folder"
          className="shrink-0 min-h-11 min-w-11 sm:min-h-8 sm:min-w-8 inline-flex items-center justify-center p-1 rounded-md text-on-surface-variant hover:bg-surface-highest hover:text-on-surface disabled:opacity-40"
        >
          <ArrowUp size={12} />
        </button>
        <span
          className="min-w-0 flex-1 truncate font-body text-xs text-on-surface"
          title={data?.path}
        >
          {data?.host ? `${data.host}:` : ""}
          {data?.path ?? path}
        </span>
      </div>
      {error && (
        <p className="px-1 font-body text-xs text-error break-words">
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
              className="w-full min-h-11 flex items-center gap-1.5 px-1 py-0.5 rounded-md font-body text-xs text-on-surface-variant hover:bg-surface-highest hover:text-on-surface"
            >
              <Folder size={11} className="shrink-0 text-on-surface-variant" />
              <span className="truncate">{name}</span>
            </button>
          </li>
        ))}
        {data && data.directories.length === 0 && !isFetching && (
          <li className="px-1 py-0.5 font-body text-xs text-on-surface-variant">No subfolders</li>
        )}
      </ul>
      <div className="flex justify-end gap-1 px-1">
        <button
          type="button"
          onClick={onClose}
          className="min-h-11 px-2 py-0.5 rounded-md font-label text-xs text-on-surface-variant hover:text-on-surface"
        >
          Cancel
        </button>
        <button
          type="button"
          data-testid="remote-folder-pick"
          disabled={!data}
          onClick={() => data && onPick(data.path)}
          className="min-h-11 px-2 py-0.5 rounded-md bg-primary/15 border border-primary/30 text-primary font-label text-xs hover:bg-primary/25 disabled:opacity-50"
        >
          Use folder
        </button>
      </div>
    </div>
  );
}
