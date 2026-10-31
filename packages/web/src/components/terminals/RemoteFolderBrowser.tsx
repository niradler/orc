import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  Folder,
  LoaderCircle,
  Pencil,
  RotateCw,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { api } from "@/api/client";
import { ActionHelp } from "@/components/ActionHelp";
import { type FolderPickerSession, useFolderPickerSession } from "@/hooks/useFolderPickerSession";
import { folderBreadcrumbs, joinFolderPath } from "@/lib/folder-picker-paths";
import { cn } from "@/lib/utils";

interface RemoteFolderBrowserProps {
  initial: string;
  host: string | null;
  onPick: (path: string) => void;
  onClose: () => void;
  session?: FolderPickerSession;
}
const iconButton =
  "inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-highest hover:text-on-surface focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-40 sm:size-8 [@media(pointer:coarse)]:size-11";

export function RemoteFolderBrowser(props: RemoteFolderBrowserProps) {
  return <FolderBrowserSession key={JSON.stringify(props.host)} {...props} />;
}

function FolderBrowserSession({
  initial,
  host,
  onPick,
  onClose,
  session,
}: RemoteFolderBrowserProps) {
  const local = useFolderPickerSession(initial);
  const { state, setState } = session ?? local;
  const { request, history, lastGood, selected, editingAddress, address } = state;
  const setSelected = (selected: string | null) =>
    setState((previous) => ({ ...previous, selected }));
  const setAddress = (address: string) => setState((previous) => ({ ...previous, address }));
  const setEditingAddress = (editingAddress: boolean) =>
    setState((previous) => ({ ...previous, editingAddress }));
  const setRequest = (request: { path: string; historyIndex?: number }) =>
    setState((previous) => ({ ...previous, request }));
  const listRef = useRef<HTMLUListElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editingAddress) {
      addressRef.current?.focus();
      addressRef.current?.select();
    }
  }, [editingAddress]);
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ["terminals", "browse", host, request.path],
    queryFn: () => api.terminals.browse(request.path || undefined, host),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });
  useEffect(() => {
    if (!data || error || isFetching) return;
    setState((previous) => {
      let history = previous.history;
      if (request.historyIndex !== undefined)
        history = { paths: history.paths, index: request.historyIndex };
      else if (history.paths[history.index] !== data.path) {
        const paths = [...history.paths.slice(0, history.index + 1), data.path];
        history = { paths, index: paths.length - 1 };
      }
      return {
        ...previous,
        lastGood: data,
        address:
          previous.editingAddress && previous.lastGood?.path === data.path
            ? previous.address
            : data.path,
        selected:
          previous.selected && data.directories.includes(previous.selected)
            ? previous.selected
            : null,
        history,
      };
    });
  }, [data, error, isFetching, request, setState]);
  const listing = data && !error ? data : lastGood;
  const blocked = isFetching || !!error || !data;
  const selectedPath = listing
    ? selected
      ? joinFolderPath(listing.path, selected)
      : listing.path
    : "";
  const navigate = (path: string, historyIndex?: number) => {
    setSelected(null);
    setAddress(path);
    setEditingAddress(false);
    setRequest({ path, historyIndex });
  };
  const go = () => {
    setSelected(null);
    setRequest({ path: address.trim() });
  };
  const crumbs = folderBreadcrumbs(listing?.path ?? request.path);
  return (
    <div data-testid="remote-folder-browser" className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-border p-2">
        <ActionHelp label="Back">
          <button
            type="button"
            data-testid="remote-folder-back"
            aria-label="Back"
            className={iconButton}
            disabled={isFetching || history.index <= 0}
            onClick={() => navigate(history.paths[history.index - 1], history.index - 1)}
          >
            <ArrowLeft size={16} />
          </button>
        </ActionHelp>
        <ActionHelp label="Forward">
          <button
            type="button"
            data-testid="remote-folder-forward"
            aria-label="Forward"
            className={iconButton}
            disabled={isFetching || history.index >= history.paths.length - 1}
            onClick={() => navigate(history.paths[history.index + 1], history.index + 1)}
          >
            <ArrowRight size={16} />
          </button>
        </ActionHelp>
        <ActionHelp label="Parent folder">
          <button
            type="button"
            data-testid="remote-folder-up"
            aria-label="Parent folder"
            className={iconButton}
            disabled={isFetching || !listing?.parent}
            onClick={() => listing?.parent && navigate(listing.parent)}
          >
            <ArrowUp size={16} />
          </button>
        </ActionHelp>
        <div className="flex min-w-0 flex-1 basis-full items-center rounded-md border border-control-border bg-surface sm:ml-1 sm:basis-auto">
          {editingAddress ? (
            <>
              <input
                ref={addressRef}
                name="folder-address"
                data-testid="remote-folder-address"
                aria-label="Folder address"
                value={address}
                maxLength={4096}
                disabled={isFetching}
                onChange={(event) => setAddress(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    go();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setEditingAddress(false);
                    setAddress(listing?.path ?? request.path);
                  }
                }}
                className="min-h-11 w-full min-w-0 bg-transparent px-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus sm:min-h-8 sm:text-sm"
              />
              <ActionHelp label="Open folder path">
                <button
                  type="button"
                  data-testid="remote-folder-address-go"
                  aria-label="Open folder path"
                  disabled={isFetching}
                  onClick={go}
                  className={iconButton}
                >
                  <ArrowRight size={16} />
                </button>
              </ActionHelp>
            </>
          ) : (
            <>
              <nav aria-label="Folder path" className="flex min-w-0 flex-1 overflow-x-auto px-1">
                {crumbs.map((crumb, index) => (
                  <div key={crumb.path} className="flex shrink-0 items-center">
                    {index > 0 && <ChevronRight size={12} className="text-muted-foreground" />}
                    <button
                      type="button"
                      data-testid="remote-folder-crumb"
                      title={crumb.path}
                      disabled={isFetching}
                      className="min-h-11 min-w-11 max-w-40 truncate rounded px-1.5 text-xs hover:bg-surface-highest focus-visible:outline-2 focus-visible:outline-focus sm:min-h-8 sm:min-w-0 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
                      onClick={() => navigate(crumb.path)}
                    >
                      {crumb.label}
                    </button>
                  </div>
                ))}
              </nav>
              <ActionHelp label="Enter folder path">
                <button
                  type="button"
                  data-testid="remote-folder-edit-address"
                  aria-label="Enter folder path"
                  className={iconButton}
                  onClick={() => {
                    setAddress(listing?.path ?? request.path);
                    setEditingAddress(true);
                  }}
                >
                  <Pencil size={14} />
                </button>
              </ActionHelp>
            </>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2 text-xs text-muted-foreground">
        <span>Name</span>
        <span>{listing ? `${listing.directories.length} folders` : ""}</span>
      </div>
      {isFetching && (
        <p
          role="status"
          data-testid="remote-folder-loading"
          className="flex shrink-0 items-center gap-2 px-4 py-2 text-xs text-muted-foreground"
        >
          <LoaderCircle size={14} className="animate-spin" />
          Loading folders…
        </p>
      )}
      {error && (
        <div
          data-testid="remote-folder-error"
          className="shrink-0 border-b border-border px-4 py-2 text-sm"
        >
          <p role="alert" className="text-error wrap-break-word">
            {error instanceof Error ? error.message : "Could not load folders."}
          </p>
          <button
            type="button"
            data-testid="remote-folder-retry"
            onClick={() => void refetch()}
            className="inline-flex min-h-11 items-center gap-2 text-xs hover:underline focus-visible:outline-2 focus-visible:outline-focus"
          >
            <RotateCw size={14} />
            Retry
          </button>
        </div>
      )}
      <ul
        ref={listRef}
        data-testid="remote-folder-list"
        aria-label="Folders"
        aria-busy={isFetching}
        className="min-h-32 max-h-[min(40dvh,24rem)] flex-1 overflow-y-auto p-2"
      >
        {listing?.directories.map((name, index) => (
          <li
            key={name}
            className={cn("flex min-w-0 rounded-md", selected === name && "bg-surface-highest")}
          >
            <button
              type="button"
              data-testid="remote-folder-entry"
              aria-pressed={selected === name}
              disabled={blocked}
              title={name}
              className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-surface focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-40"
              onClick={() => setSelected(name)}
              onDoubleClick={() => !blocked && navigate(joinFolderPath(listing.path, name))}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  navigate(joinFolderPath(listing.path, name));
                }
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const step = event.key === "ArrowDown" ? 1 : -1;
                  const entries = listRef.current?.querySelectorAll<HTMLButtonElement>(
                    '[data-testid="remote-folder-entry"]',
                  );
                  entries?.[
                    Math.max(0, Math.min(listing.directories.length - 1, index + step))
                  ]?.focus();
                }
              }}
            >
              <Folder size={18} className="shrink-0 text-warning" />
              <span data-testid={`remote-folder-name-${name}`} className="truncate">
                {name}
              </span>
            </button>
            <ActionHelp label={`Open folder ${name}`}>
              <button
                type="button"
                data-testid="remote-folder-open"
                aria-label={`Open folder ${name}`}
                disabled={blocked}
                className={cn(iconButton, "my-0.5 mr-0.5 self-center")}
                onClick={() => navigate(joinFolderPath(listing.path, name))}
              >
                <ChevronRight size={16} />
              </button>
            </ActionHelp>
          </li>
        ))}
        {listing && listing.directories.length === 0 && !isFetching && !error && (
          <li className="px-2 py-8 text-center text-sm text-muted-foreground">No subfolders</li>
        )}
      </ul>
      <div className="shrink-0 space-y-2 border-t border-border bg-surface px-4 py-3">
        <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <span className="shrink-0">Folder</span>
          <input
            data-testid="remote-folder-selection"
            aria-label="Selected folder"
            readOnly
            value={selectedPath}
            title={selectedPath}
            className="min-h-11 min-w-0 flex-1 rounded border border-control-border bg-background px-2 text-sm text-on-surface focus-visible:outline-2 focus-visible:outline-focus sm:min-h-8"
          />
        </label>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            data-testid="remote-folder-cancel"
            onClick={onClose}
            className="min-h-11 rounded-md px-3 text-sm text-muted-foreground hover:bg-surface-highest focus-visible:outline-2 focus-visible:outline-focus"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="remote-folder-pick"
            disabled={blocked || !selectedPath}
            onClick={() => !blocked && selectedPath && onPick(selectedPath)}
            className="min-h-11 rounded-md bg-primary px-3 text-sm text-primary-foreground focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-40"
          >
            Select folder
          </button>
        </div>
      </div>
    </div>
  );
}
