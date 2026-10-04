import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Braces,
  ChevronRight,
  ChevronsDownUp,
  File,
  FileCode2,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
  RefreshCw,
  X,
} from "lucide-react";
import { type KeyboardEvent, lazy, type ReactElement, Suspense, useState } from "react";
import { api, type Terminal } from "@/api/client";
import "./FilePanel.css";

const FileEditor = lazy(() =>
  import("./FileEditor").then((module) => ({ default: module.FileEditor })),
);

function fileIcon(name: string): typeof File {
  const extension = name.split(".").pop()?.toLowerCase();
  if (["ts", "tsx", "js", "jsx", "py", "sh", "css", "html", "rs", "go"].includes(extension ?? ""))
    return FileCode2;
  if (["json", "yml", "yaml", "toml", "xml"].includes(extension ?? "")) return Braces;
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"].includes(extension ?? ""))
    return FileImage;
  if (["md", "txt", "log", "csv"].includes(extension ?? "")) return FileText;
  return File;
}

type DirectoryProps = {
  terminalId: string;
  path: string;
  selected: string | null;
  expanded: Set<string>;
  toggle: (path: string) => void;
  select: (path: string) => void;
};

function Directory({
  terminalId,
  path,
  selected,
  expanded,
  toggle,
  select,
}: DirectoryProps): ReactElement {
  const files = useQuery({
    queryKey: ["checkout-files", terminalId, path],
    queryFn: () => api.git.files(terminalId, path),
  });
  return (
    <ul className={path ? "ml-3 border-l border-outline/20 pl-1" : ""}>
      {files.isPending && <li className="px-3 py-2 text-xs text-outline">Loading files…</li>}
      {files.error && (
        <li role="alert" className="px-3 py-2 text-xs text-error">
          {files.error.message}
        </li>
      )}
      {files.data?.entries?.length === 0 && (
        <li className="px-3 py-2 text-xs text-outline">Empty folder</li>
      )}
      {files.data?.entries?.map((entry) => {
        const open = expanded.has(entry.path);
        let Icon = fileIcon(entry.name);
        if (entry.directory) Icon = open ? FolderOpen : Folder;
        return (
          <li key={entry.path}>
            <button
              type="button"
              data-testid="file-entry"
              data-path={entry.path}
              aria-expanded={entry.directory ? open : undefined}
              aria-current={!entry.directory && selected === entry.path ? "true" : undefined}
              title={entry.path}
              onClick={() => (entry.directory ? toggle(entry.path) : select(entry.path))}
              className={`flex h-8 w-full min-w-0 items-center gap-2 rounded px-2 text-left text-[13px] focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary ${selected === entry.path ? "bg-primary/15 text-primary" : "hover:bg-surface-highest"}`}
            >
              <span className="flex w-3 shrink-0 items-center">
                {entry.directory && (
                  <ChevronRight
                    size={12}
                    className={`transition-transform ${open ? "rotate-90" : ""}`}
                  />
                )}
              </span>
              <Icon
                size={15}
                className={`shrink-0 ${entry.directory ? "text-primary/80" : "text-outline"}`}
              />
              <span className="truncate">{entry.name}</span>
            </button>
            {entry.directory && open && (
              <Directory
                terminalId={terminalId}
                path={entry.path}
                selected={selected}
                expanded={expanded}
                toggle={toggle}
                select={select}
              />
            )}
          </li>
        );
      })}
      {files.data?.truncated && (
        <li className="px-3 py-2 text-xs text-outline">Showing the first 500 entries.</li>
      )}
    </ul>
  );
}

export function FilePanel({ terminal }: { terminal: Terminal }): ReactElement {
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [rootOpen, setRootOpen] = useState(true);
  const [expanded, setExpanded] = useState(new Set<string>());
  const queryClient = useQueryClient();
  const root = useQuery({
    queryKey: ["checkout-files", terminal.id, ""],
    queryFn: () => api.git.files(terminal.id, ""),
  });
  const preview = useQuery({
    queryKey: ["checkout-files", terminal.id, selected],
    queryFn: () => api.git.files(terminal.id, selected ?? ""),
    enabled: selected !== null,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
  const rootPath = root.data?.root ?? terminal.cwd ?? "";
  const rootName =
    rootPath.replace(/\\/g, "/").replace(/\/$/, "").split("/").pop() || rootPath || "Files";
  function selectFile(path: string | null): void {
    if (path === selected) return;
    if (
      dirty &&
      !window.confirm("Leave this file with unsaved changes? Your draft will be kept in this page.")
    )
      return;
    setDirty(false);
    setSelected(path);
  }
  function navigateTree(event: KeyboardEvent<HTMLElement>): void {
    if (!(event.target instanceof HTMLButtonElement)) return;
    const buttons = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-path]"),
    ];
    const index = buttons.indexOf(event.target);
    const path = event.target.dataset.path ?? "";
    const open = event.target.getAttribute("aria-expanded");
    let next: HTMLButtonElement | undefined;
    if (event.key === "ArrowDown") next = buttons[index + 1];
    else if (event.key === "ArrowUp") next = buttons[index - 1];
    else if (event.key === "Home") next = buttons[0];
    else if (event.key === "End") next = buttons[buttons.length - 1];
    else if (event.key === "ArrowRight") {
      if (open === "false") event.target.click();
      else if (open === "true") next = buttons[index + 1];
    } else if (event.key === "ArrowLeft") {
      if (open === "true") event.target.click();
      else
        next = buttons.find(
          (button) => button.dataset.path === path.split("/").slice(0, -1).join("/"),
        );
    } else return;
    event.preventDefault();
    next?.focus();
  }
  return (
    <div
      data-testid="file-panel"
      className="file-panel flex flex-1 min-h-0 min-w-0 flex-col overflow-hidden text-sm"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-surface-highest px-3 py-2">
        <span className="min-w-0 flex-1 text-[10px] font-semibold uppercase tracking-widest text-outline">
          Explorer
        </span>
        <button
          type="button"
          data-testid="files-collapse"
          aria-label="Collapse all folders"
          title="Collapse all folders"
          disabled={expanded.size === 0}
          onClick={() => setExpanded(new Set())}
          className="rounded p-1 text-outline hover:bg-surface-highest hover:text-primary disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <ChevronsDownUp size={14} />
        </button>
        <button
          type="button"
          data-testid="files-refresh"
          aria-label="Refresh files"
          title="Refresh files"
          onClick={() =>
            void queryClient.invalidateQueries({ queryKey: ["checkout-files", terminal.id] })
          }
          className="rounded p-1 text-outline hover:bg-surface-highest hover:text-primary"
        >
          <RefreshCw size={14} className={root.isFetching ? "animate-spin" : ""} />
        </button>
      </header>
      <div className="file-panel-body" data-preview={selected !== null}>
        <nav
          aria-label="Project files"
          data-testid="files-tree"
          onKeyDown={navigateTree}
          className="file-panel-tree overflow-auto p-2"
        >
          <button
            type="button"
            data-testid="files-root"
            data-path=""
            title={rootPath}
            aria-expanded={rootOpen}
            onClick={() => setRootOpen((open) => !open)}
            className="mb-1 flex h-8 w-full min-w-0 items-center gap-2 rounded px-2 text-left text-[13px] font-semibold hover:bg-surface-highest focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary"
          >
            <ChevronRight
              size={12}
              className={`shrink-0 transition-transform ${rootOpen ? "rotate-90" : ""}`}
            />
            <FolderOpen size={16} className="shrink-0 text-primary" />
            <span className="truncate">{rootName}</span>
          </button>
          {rootOpen && (
            <div className="ml-3 border-l border-outline/20 pl-1">
              <Directory
                terminalId={terminal.id}
                path=""
                selected={selected}
                expanded={expanded}
                select={selectFile}
                toggle={(path) =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(path)) next.delete(path);
                    else next.add(path);
                    return next;
                  })
                }
              />
            </div>
          )}
        </nav>
        {selected !== null && (
          <section aria-label="File preview" className="file-panel-preview flex flex-col">
            <header className="flex shrink-0 items-center gap-2 bg-surface px-3 py-1.5">
              <File size={14} className="shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">
                  {selected.split("/").pop()}
                  {dirty && (
                    <span className="ml-2 text-primary" title="Unsaved changes">
                      ●
                    </span>
                  )}
                </p>
                <p title={selected} className="truncate pt-0.5 text-[10px] text-outline">
                  {selected}
                </p>
              </div>
              <button
                type="button"
                data-testid="file-preview-close"
                aria-label="Close file preview"
                onClick={() => selectFile(null)}
                className="rounded p-1 text-outline hover:bg-surface-highest"
              >
                <X size={14} />
              </button>
            </header>
            {preview.isPending && <p className="p-3 text-xs text-outline">Loading preview…</p>}
            {preview.error && (
              <p role="alert" className="p-3 text-xs text-error">
                {preview.error.message}
              </p>
            )}
            {preview.data?.binary && (
              <p className="p-3 text-xs text-outline">Binary file; text preview unavailable.</p>
            )}
            {preview.data?.content != null && (
              <Suspense fallback={<p className="p-3 text-xs text-outline">Loading editor…</p>}>
                <FileEditor
                  key={`${terminal.id}:${selected}`}
                  terminalId={terminal.id}
                  path={selected}
                  content={preview.data.content}
                  readOnly={preview.data.truncated}
                  onDirty={setDirty}
                />
              </Suspense>
            )}
            {preview.data?.truncated && (
              <p className="px-3 py-1 text-xs text-outline">Preview limited to 200 KB.</p>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
