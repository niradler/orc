import type { KbDocumentListing, KnowledgeBase } from "@orc/core/kb";
import {
  BookOpen,
  Check,
  ChevronDown,
  FileText,
  Folder,
  FolderTree,
  Plus,
  Search,
  Tag,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { HelpPopover } from "@/components/HelpPopover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useKbStatus } from "@/hooks/useKnowledge";
import { useScratchpads } from "@/hooks/useScratchpads";
import { cn } from "@/lib/utils";

const LABEL_LIMIT = 8;

function countFor(folder: string, listing: KbDocumentListing | undefined): number {
  if (!folder) return listing?.documents.length ?? 0;
  return (listing?.documents ?? []).filter((doc) => doc.path.startsWith(`${folder}/`)).length;
}

export function KbRail({
  bases,
  kb,
  projectName,
  listing,
  projectId,
  folder,
  label,
  queryInput,
  onQueryInput,
  onSearch,
  onSelectKb,
  onCreateKb,
  onFolder,
  onLabel,
  onLabels,
  onClose,
}: {
  bases: KnowledgeBase[];
  kb: KnowledgeBase | null;
  projectName: (id: string | null) => string;
  listing: KbDocumentListing | undefined;
  projectId: string | undefined;
  folder: string;
  label: string;
  queryInput: string;
  onQueryInput: (value: string) => void;
  onSearch: () => void;
  onSelectKb: (id: string) => void;
  onCreateKb: () => void;
  onFolder: (folder: string) => void;
  onLabel: (label: string) => void;
  onLabels: () => void;
  onClose?: () => void;
}) {
  const [allLabels, setAllLabels] = useState(false);
  const folders = [
    ...new Set(
      (listing?.documents ?? []).flatMap((doc) => {
        const parts = doc.path.split("/").slice(0, -1);
        return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
      }),
    ),
  ].sort((a, b) => a.localeCompare(b));
  const labels = [...(listing?.labels ?? [])].sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label),
  );
  const shownLabels = allLabels ? labels : labels.slice(0, LABEL_LIMIT);
  const pads = useScratchpads({
    ...(projectId ? { project_id: projectId } : { unassigned: "true" as const }),
    ...(projectId ? { include_global: "true" as const } : {}),
    limit: 6,
  });
  return (
    <nav
      id="kb-sidebar-panel"
      aria-label="Knowledge navigation"
      data-testid="kb-sidebar"
      className="flex h-full min-h-0 w-full flex-col border-outline-variant bg-background lg:w-72 lg:shrink-0 lg:border-r"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-outline-variant p-3">
        <KbSwitcher
          bases={bases}
          kb={kb}
          projectName={projectName}
          onSelect={onSelectKb}
          onCreate={onCreateKb}
        />
        <Button
          size="icon"
          variant="ghost"
          aria-label="New knowledge base"
          data-testid="kb-create"
          className="size-8 shrink-0"
          onClick={onCreateKb}
        >
          <Plus size={16} />
        </Button>
        {onClose && (
          <Button
            size="sm"
            variant="ghost"
            data-testid="kb-browser-close"
            onClick={onClose}
            aria-label="Close knowledge browser"
          >
            Close
          </Button>
        )}
      </div>
      <form
        className="flex shrink-0 items-center gap-1.5 border-b border-outline-variant p-2"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          onSearch();
        }}
      >
        <Search size={14} className="ml-1 shrink-0 text-outline" aria-hidden />
        <Input
          aria-label="Search knowledge"
          data-testid="kb-search-input"
          autoFocus={Boolean(onClose)}
          value={queryInput}
          onChange={(event) => onQueryInput(event.target.value)}
          placeholder="Search knowledge"
          className="h-8 min-w-0 flex-1 border-0 bg-transparent px-1 focus-visible:outline-hidden"
        />
        <Button
          type="submit"
          size="icon"
          variant="ghost"
          className="size-7 shrink-0"
          aria-label="Search"
          data-testid="kb-search-submit"
        >
          <Search size={14} />
        </Button>
        <kbd className="mr-1 hidden rounded border border-border px-1 text-[10px] text-outline sm:block">
          ⌘K
        </kbd>
      </form>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-2">
        <section aria-label="Knowledge bases">
          <div className="flex items-center justify-between px-2 pb-1">
            <h2 className="text-xs font-medium text-outline">Knowledge bases</h2>
            <HelpPopover label="Knowledge bases">
              Upload documents, write Markdown or sync a folder. Agents search this knowledge with
              citations.
            </HelpPopover>
          </div>
          <ul className="space-y-0.5" data-testid="kb-list">
            {bases.map((base) => (
              <li key={base.id}>
                <button
                  type="button"
                  data-testid="kb-row"
                  data-kb-name={base.name}
                  aria-current={base.id === kb?.id ? "page" : undefined}
                  className={cn(
                    "flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-surface-high",
                    base.id === kb?.id && "bg-surface-highest font-medium",
                  )}
                  onClick={() => onSelectKb(base.id)}
                >
                  <BookOpen size={15} className="shrink-0 text-outline" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{base.name}</span>
                  <span className="text-xs font-normal tabular-nums text-outline">
                    {base.document_count}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {bases.length === 0 && (
            <button
              type="button"
              className="mt-1 block w-full rounded-md px-2 py-2 text-left text-sm text-primary hover:bg-surface-high"
              onClick={onCreateKb}
            >
              New knowledge base
            </button>
          )}
        </section>

        {kb && folders.length > 0 && (
          <section aria-label="Folders">
            <div className="flex items-center justify-between px-2 pb-1">
              <h2 className="text-xs font-medium text-outline">Folders</h2>
              <FolderTree size={13} className="text-outline" aria-hidden />
            </div>
            <button
              type="button"
              data-testid="kb-folder-all"
              aria-current={!folder ? "page" : undefined}
              className={cn(
                "flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-outline hover:bg-surface-high hover:text-on-surface",
                !folder && "bg-surface-high text-on-surface",
              )}
              onClick={() => onFolder("")}
            >
              <Folder size={14} aria-hidden />
              <span className="flex-1">All documents</span>
              <span className="text-xs tabular-nums">{listing?.documents.length ?? 0}</span>
            </button>
            <ul className="space-y-0.5">
              {folders.map((path) => (
                <li key={path}>
                  <button
                    type="button"
                    data-testid="kb-folder-row"
                    data-folder={path}
                    aria-current={folder === path ? "page" : undefined}
                    className={cn(
                      "flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-outline hover:bg-surface-high hover:text-on-surface",
                      folder === path && "bg-surface-high text-on-surface",
                    )}
                    style={{ paddingLeft: `${8 + (path.split("/").length - 1) * 12}px` }}
                    onClick={() => onFolder(path)}
                  >
                    <Folder size={14} className="shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{path.split("/").pop()}</span>
                    <span className="text-xs tabular-nums">{countFor(path, listing)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {kb && labels.length > 0 && (
          <section aria-label="Labels">
            <div className="flex items-center justify-between px-2 pb-1">
              <h2 className="text-xs font-medium text-outline">Labels</h2>
              <div className="flex items-center">
                <Tag size={13} className="text-outline" aria-hidden />
                <button
                  type="button"
                  className="ml-1 text-[11px] text-primary hover:underline"
                  onClick={onLabels}
                >
                  Manage
                </button>
              </div>
            </div>
            <div className="flex flex-wrap gap-1 px-1">
              {shownLabels.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  data-testid="kb-label-filter"
                  aria-pressed={label === item.label}
                  className={cn(
                    "inline-flex min-h-7 max-w-full items-center gap-1 rounded-full border px-2 text-xs",
                    label === item.label
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-outline-variant text-outline hover:text-on-surface",
                  )}
                  onClick={() => onLabel(label === item.label ? "" : item.label)}
                >
                  <span className="truncate">{item.label}</span>
                  <span className="tabular-nums">{item.count}</span>
                </button>
              ))}
            </div>
            {labels.length > LABEL_LIMIT && (
              <button
                type="button"
                data-testid="kb-labels-more"
                className="mt-1 px-2 text-xs text-primary hover:underline"
                onClick={() => setAllLabels(!allLabels)}
              >
                {allLabels ? "Fewer labels" : `${labels.length - LABEL_LIMIT} more`}
              </button>
            )}
          </section>
        )}

        <section aria-label="Pads">
          <div className="flex items-center justify-between px-2 pb-1">
            <h2 className="text-xs font-medium text-outline">Pads</h2>
            <Link
              to="/scratchpad"
              className="text-[11px] text-primary hover:underline"
              data-testid="kb-pads-all"
            >
              All pads
            </Link>
          </div>
          <ul className="space-y-0.5">
            {(pads.data?.scratchpads ?? []).slice(0, 5).map((pad) => (
              <li key={pad.id}>
                <Link
                  to={`/scratchpad/${pad.id}`}
                  data-testid="kb-pad-link"
                  className="flex min-h-8 items-center gap-2 rounded-md px-2 text-sm text-outline hover:bg-surface-high hover:text-on-surface"
                >
                  <FileText size={13} className="shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{pad.title}</span>
                </Link>
              </li>
            ))}
            {pads.data && pads.data.scratchpads.length === 0 && (
              <li className="px-2 py-1 text-xs text-outline">No pads yet</li>
            )}
          </ul>
        </section>
      </div>
      <KbStatusLine />
    </nav>
  );
}

function KbSwitcher({
  bases,
  kb,
  projectName,
  onSelect,
  onCreate,
}: {
  bases: KnowledgeBase[];
  kb: KnowledgeBase | null;
  projectName: (id: string | null) => string;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="kb-switcher"
          className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left hover:bg-surface-high"
          aria-label="Choose knowledge base"
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded bg-surface-highest text-[11px] font-medium">
            {kb ? kb.name.slice(0, 1).toUpperCase() : "K"}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{kb?.name ?? "Knowledge"}</span>
            <span className="block truncate text-[11px] text-outline">
              {kb ? projectName(kb.project_id) : "All workspaces"}
            </span>
          </span>
          <ChevronDown size={14} className="shrink-0 text-outline" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-1" data-testid="kb-switcher-menu">
        <div className="max-h-72 overflow-y-auto">
          {bases.map((base) => (
            <button
              key={base.id}
              type="button"
              className="flex min-h-9 w-full items-center gap-2 rounded px-2 text-left text-sm hover:bg-surface-high"
              onClick={() => onSelect(base.id)}
            >
              <BookOpen size={14} className="text-outline" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{base.name}</span>
              <span className="text-xs text-outline">{projectName(base.project_id)}</span>
              {base.id === kb?.id && <Check size={14} aria-hidden />}
            </button>
          ))}
        </div>
        <div className="mt-1 border-t border-outline-variant pt-1">
          <button
            type="button"
            data-testid="kb-create-from-switcher"
            className="flex min-h-9 w-full items-center gap-2 rounded px-2 text-left text-sm text-primary hover:bg-surface-high"
            onClick={onCreate}
          >
            <Plus size={14} aria-hidden />
            New knowledge base
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function KbStatusLine() {
  const status = useKbStatus();
  const s = status.data;
  const searchMode = !s
    ? null
    : s.embedding.provider === "none"
      ? {
          text: "Keyword search only",
          title: "Configure embeddings in Settings to also search by meaning",
        }
      : s.embedding.ready
        ? { text: "Hybrid search", title: s.embedding.model ?? undefined }
        : { text: "Embeddings not ready", title: s.embedding.detail ?? "" };
  const jobs = s ? s.jobs.queued + s.jobs.running : 0;
  return (
    <p
      role="status"
      data-testid="kb-status"
      className="shrink-0 border-t border-outline-variant px-4 py-2 text-xs text-outline"
    >
      {s ? (
        <>
          <span title={searchMode?.title}>{searchMode?.text}</span>
          {jobs ? ` · ${jobs} processing` : ""}
        </>
      ) : status.error ? (
        "Knowledge status unavailable"
      ) : (
        "Loading…"
      )}
    </p>
  );
}
