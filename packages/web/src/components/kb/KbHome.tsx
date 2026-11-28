import type { KbBulkAction, KbDocumentListing, KnowledgeBase } from "@orc/core/kb";
import {
  ArrowDown,
  ArrowUp,
  FilePlus,
  FolderInput,
  FolderSync,
  List,
  Rows3,
  Tag,
  Trash2,
  Upload,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { api } from "@/api/client";
import { BulkActionBar } from "@/components/BulkActionBar";
import { ConfirmDialog } from "@/components/ConfirmDialog";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useInvalidateKb, useKbMaintenance } from "@/hooks/useKnowledge";
import { useListSelection } from "@/hooks/useListSelection";
import { saveFile } from "@/lib/save-file";
import { cn } from "@/lib/utils";

const SHELF = 4;

type SortKey = "title" | "updated" | "reads";
type Sort = { key: SortKey; desc: boolean };
type Row = KbDocumentListing["documents"][number];

function compare(a: Row, b: Row, key: SortKey): number {
  if (key === "title") return a.title.localeCompare(b.title);
  if (key === "updated") return a.updated_at - b.updated_at;
  return a.reads - b.reads;
}

function ariaSort(sort: Sort, key: SortKey): "ascending" | "descending" | undefined {
  if (sort.key !== key) return undefined;
  return sort.desc ? "descending" : "ascending";
}

function shortDate(ms: number): string {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

/** A knowledge base's reading desk: what changed, what is read, labels, then every document. */
export function KbHome({
  kb,
  owner,
  listing,
  label,
  folder,
  intake,
  onLabel,
  onFolder,
  onOpen,
  onNewDocument,
  onIntake,
  onLabels,
  onBulkDone,
  onNavigate,
}: {
  kb: KnowledgeBase;
  owner: string;
  listing: KbDocumentListing | undefined;
  label: string;
  folder: string;
  intake?: { processing: number; failed: number };
  onLabel: (label: string | null) => void;
  onFolder: (folder: string) => void;
  onOpen: (documentId: string) => void;
  onNewDocument: () => void;
  onIntake: () => void;
  onLabels: () => void;
  onBulkDone: () => void;
  onNavigate: (view: "search" | "labels" | "home") => void;
}) {
  const invalidate = useInvalidateKb();
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<Sort>({ key: "updated", desc: true });
  const [view, setView] = useState<"list" | "table">("list");
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const agentsEdit = kb.editable_by.includes("mcp");
  const needle = filter.trim().toLowerCase();
  const docs = listing?.documents ?? [];
  const rows = docs
    .filter(
      (doc) =>
        (!label || doc.labels.includes(label)) &&
        (!folder || doc.path.startsWith(`${folder}/`)) &&
        (!needle ||
          doc.title.toLowerCase().includes(needle) ||
          doc.path.toLowerCase().includes(needle) ||
          doc.labels.some((item) => item.toLowerCase().includes(needle))),
    )
    .sort((a, b) => compare(a, b, sort.key) * (sort.desc ? -1 : 1));
  const selection = useListSelection(
    rows.map((row) => row.id),
    `${kb.id}:${label}:${folder}:${needle}`,
  );
  const unfiltered = !label && !folder && !needle;
  const recent = unfiltered
    ? [...docs].sort((a, b) => b.updated_at - a.updated_at).slice(0, SHELF)
    : [];
  const mostRead = unfiltered
    ? [...docs]
        .filter((doc) => doc.reads > 0)
        .sort((a, b) => b.reads - a.reads)
        .slice(0, SHELF)
    : [];
  const labels = [...(listing?.labels ?? [])].sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label),
  );

  function sortBy(key: SortKey): void {
    setSort((current) =>
      current.key === key ? { key, desc: !current.desc } : { key, desc: key !== "title" },
    );
  }
  function header(key: SortKey, text: string) {
    const Arrow = sort.desc ? ArrowDown : ArrowUp;
    return (
      <button
        type="button"
        data-testid={`kb-sort-${key}`}
        className="inline-flex min-h-8 items-center gap-1 hover:text-on-surface"
        onClick={() => sortBy(key)}
      >
        {text}
        {sort.key === key && <Arrow size={12} aria-hidden />}
      </button>
    );
  }

  async function exportBundle() {
    setBusy(true);
    setBulkError(null);
    try {
      saveFile(await api.kb.exportOkf(kb.id), `${kb.name.replace(/[^\w.-]+/g, "-")}-okf.zip`);
    } catch (cause) {
      setBulkError(cause instanceof Error ? cause.message : "Export failed");
    } finally {
      setBusy(false);
    }
  }

  async function runBulk(action: KbBulkAction) {
    setBusy(true);
    setBulkError(null);
    try {
      const result = await api.kb.bulk(kb.id, action);
      await invalidate();
      selection.clear();
      onBulkDone();
      if (result.failures.length)
        setBulkError(
          `${result.failures.length} could not be changed: ${result.failures
            .slice(0, 2)
            .map((failure) => failure.error)
            .join("; ")}`,
        );
    } catch (cause) {
      setBulkError(cause instanceof Error ? cause.message : "Bulk action failed");
    } finally {
      setBusy(false);
    }
  }

  const rowTitle = (doc: Row) => (
    <>
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate text-sm font-medium">{doc.title}</span>
        {doc.origin === "external" && (
          <FolderSync
            size={13}
            className="shrink-0 text-outline"
            aria-label="From a synced folder"
          />
        )}
        {doc.parse_state === "failed" && (
          <span className="shrink-0 text-xs text-error">Parse failed</span>
        )}
        {doc.parse_state === "pending" && (
          <span className="shrink-0 text-xs text-outline">Parsing…</span>
        )}
      </span>
      <span className="block truncate font-mono text-xs text-outline">{doc.path}</span>
    </>
  );

  return (
    <div data-testid="kb-overview" className="w-full min-w-0 space-y-6 p-4 sm:p-6">
      <header className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-xs text-outline">Knowledge base</p>
            <h1
              className="wrap-break-word text-2xl font-medium tracking-tight"
              data-testid="kb-overview-name"
            >
              {kb.name}
            </h1>
            {kb.description && (
              <p className="max-w-[68ch] text-sm text-outline">{kb.description}</p>
            )}
            <p className="text-xs text-outline" data-testid="kb-overview-meta">
              {owner} · {kb.document_count} {kb.document_count === 1 ? "document" : "documents"} ·{" "}
              {agentsEdit ? "agents can edit" : "agents read only"} ·{" "}
              {kb.parser ? `Parser ${kb.parser}` : "Workspace parser"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" data-testid="kb-new-document" onClick={onNewDocument}>
              <FilePlus size={16} />
              New document
            </Button>
            <Button size="sm" variant="outline" data-testid="kb-intake-open" onClick={onIntake}>
              <Upload size={16} />
              Add
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-outline">
          <button
            type="button"
            className="hover:text-on-surface"
            data-testid="kb-open-search"
            onClick={() => onNavigate("search")}
          >
            Search this knowledge base
          </button>
          <span aria-hidden>·</span>
          <button
            type="button"
            className="hover:text-on-surface"
            data-testid="kb-open-labels"
            onClick={onLabels}
          >
            Manage labels
          </button>
          <span aria-hidden>·</span>
          <button
            type="button"
            className="hover:text-on-surface"
            onClick={() => void exportBundle()}
            data-testid="kb-export-okf"
          >
            Export OKF
          </button>
        </div>
      </header>

      {intake && (intake.processing > 0 || intake.failed > 0) && (
        <section
          data-testid="kb-intake-strip"
          className="flex flex-wrap items-center gap-2 rounded-md border border-outline-variant bg-surface px-3 py-2 text-sm"
        >
          <span className="flex flex-1 flex-wrap items-center gap-x-3 gap-y-1">
            {intake.processing > 0 && (
              <span className="inline-flex items-center gap-1.5 text-outline">
                <span className="size-1.5 rounded-full bg-progress" aria-hidden />
                {intake.processing} file{intake.processing === 1 ? "" : "s"} processing
              </span>
            )}
            {intake.failed > 0 && (
              <span className="inline-flex items-center gap-1.5 text-error">
                <span className="size-1.5 rounded-full bg-error" aria-hidden />
                {intake.failed} failed
              </span>
            )}
          </span>
          <Button size="sm" variant="ghost" onClick={onIntake} data-testid="kb-intake-review">
            Open intake
          </Button>
        </section>
      )}

      <Attention kbId={kb.id} onOpen={onOpen} />

      {(recent.length > 0 || mostRead.length > 0) && (
        <div className="grid gap-6 lg:grid-cols-2">
          {recent.length > 0 && (
            <Shelf title="Recently updated" onMore={() => setSort({ key: "updated", desc: true })}>
              {recent.map((doc) => (
                <ShelfRow
                  key={doc.id}
                  doc={doc}
                  detail={shortDate(doc.updated_at)}
                  onOpen={onOpen}
                />
              ))}
            </Shelf>
          )}
          {mostRead.length > 0 && (
            <Shelf
              title="Most read"
              hint="by agents and people"
              onMore={() => setSort({ key: "reads", desc: true })}
            >
              {mostRead.map((doc) => (
                <ShelfRow
                  key={doc.id}
                  doc={doc}
                  detail={`${doc.reads} ${doc.reads === 1 ? "read" : "reads"}`}
                  onOpen={onOpen}
                />
              ))}
            </Shelf>
          )}
        </div>
      )}

      {labels.length > 0 && (
        <section aria-labelledby="kb-labels-heading" className="space-y-2" data-testid="kb-labels">
          <div className="flex items-center gap-2">
            <h2 id="kb-labels-heading" className="mr-auto text-sm font-medium text-outline">
              Labels <span className="font-normal">{labels.length}</span>
            </h2>
            <button
              type="button"
              className="text-xs text-primary hover:underline"
              onClick={onLabels}
            >
              Manage labels
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {labels.slice(0, 12).map((item) => (
              <button
                key={item.label}
                type="button"
                data-testid="kb-home-label"
                aria-pressed={label === item.label}
                className={cn(
                  "inline-flex min-h-7 items-center gap-1 rounded-full border px-2.5 text-xs",
                  label === item.label
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-outline-variant text-outline hover:text-on-surface",
                )}
                onClick={() => onLabel(label === item.label ? null : item.label)}
              >
                {item.label} <span className="tabular-nums">{item.count}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <section
        aria-labelledby="kb-documents-heading"
        data-testid="kb-documents"
        className="space-y-3"
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="mr-auto flex min-w-0 flex-wrap items-baseline gap-2">
            <h2 id="kb-documents-heading" className="text-sm font-medium text-outline">
              {folder ? folder.split("/").pop() : "All documents"}
              <span className="ml-1.5 font-normal">{rows.length}</span>
            </h2>
            {label && (
              <button
                type="button"
                className="text-xs text-primary hover:underline"
                onClick={() => onLabel(null)}
              >
                Labelled {label} · clear
              </button>
            )}
            {folder && (
              <button
                type="button"
                className="text-xs text-primary hover:underline"
                onClick={() => onFolder("")}
              >
                All folders
              </button>
            )}
          </div>
          <div className="flex items-center gap-1 rounded-md border border-outline-variant p-0.5">
            <button
              type="button"
              data-testid="kb-view-list"
              aria-pressed={view === "list"}
              className={cn(
                "inline-flex min-h-7 items-center gap-1 rounded px-2 text-xs",
                view === "list" ? "bg-surface-highest text-on-surface" : "text-outline",
              )}
              onClick={() => setView("list")}
            >
              <List size={13} /> List
            </button>
            <button
              type="button"
              data-testid="kb-view-table"
              aria-pressed={view === "table"}
              className={cn(
                "inline-flex min-h-7 items-center gap-1 rounded px-2 text-xs",
                view === "table" ? "bg-surface-highest text-on-surface" : "text-outline",
              )}
              onClick={() => setView("table")}
            >
              <Rows3 size={13} /> Table
            </button>
          </div>
        </div>

        {kb.document_count > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="Filter documents"
              data-testid="kb-documents-filter"
              placeholder="Filter by title, path or label"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              className="h-9 w-full sm:w-72"
            />
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" data-testid="kb-sort-menu">
                  Sort:{" "}
                  {sort.key === "updated" ? "Updated" : sort.key === "reads" ? "Reads" : "Title"}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-44 p-1">
                {(
                  [
                    ["updated", "Updated"],
                    ["reads", "Reads"],
                    ["title", "Title"],
                  ] as const
                ).map(([key, text]) => (
                  <button
                    key={key}
                    type="button"
                    data-testid={`kb-sort-option-${key}`}
                    className="flex min-h-8 w-full items-center rounded px-2 text-left text-sm hover:bg-surface-high"
                    onClick={() => sortBy(key)}
                  >
                    {text}
                    {sort.key === key && (
                      <span className="ml-auto text-xs text-outline">{sort.desc ? "↓" : "↑"}</span>
                    )}
                  </button>
                ))}
              </PopoverContent>
            </Popover>
          </div>
        )}

        {bulkError && (
          <p role="alert" className="text-sm text-error" data-testid="kb-bulk-error">
            {bulkError}
          </p>
        )}

        {rows.length > 0 && (
          <BulkActionBar
            count={selection.selectedIds.length}
            allSelected={selection.allSelected}
            someSelected={selection.someSelected}
            onSelectAll={selection.selectAll}
            onClear={selection.clear}
            disabled={busy}
            resourceLabel="documents"
          >
            <BulkLabel
              onApply={(labels) =>
                void runBulk({ ids: selection.selectedIds, action: "label", labels })
              }
            />
            <MoveFolder
              onApply={(next) =>
                void runBulk({ ids: selection.selectedIds, action: "move", folder: next })
              }
            />
            <Button
              size="sm"
              variant="ghost"
              className="text-error"
              data-testid="kb-bulk-delete"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={14} /> Delete
            </Button>
          </BulkActionBar>
        )}

        {kb.document_count === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-outline-variant px-6 py-10 text-center text-sm text-outline">
            <Upload size={22} className="text-primary" aria-hidden />
            <span>
              This knowledge base is empty. Drop PDF, Word, PowerPoint, Excel, HTML, Markdown or
              text files here, or
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={onNewDocument}
              data-testid="kb-overview-new-document"
            >
              add a document
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <p className="py-4 text-sm text-outline" data-testid="kb-documents-empty">
            No documents match.{" "}
            <button
              type="button"
              data-testid="kb-documents-clear"
              className="text-primary hover:underline"
              onClick={() => {
                setFilter("");
                onLabel(null);
                onFolder("");
              }}
            >
              Clear filters
            </button>
          </p>
        ) : view === "list" ? (
          <ul className="divide-y divide-outline-variant/60" data-testid="kb-document-list">
            {rows.map((doc) => (
              <li
                key={doc.id}
                data-testid="kb-document-row"
                data-document-title={doc.title}
                className="flex min-h-11 items-start gap-2 py-1.5 hover:bg-surface-high"
              >
                <input
                  type="checkbox"
                  aria-label={`Select ${doc.title}`}
                  className="mt-2 size-4 shrink-0 accent-primary"
                  checked={selection.selectedIds.includes(doc.id)}
                  onChange={() => selection.toggle(doc.id)}
                />
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => onOpen(doc.id)}
                >
                  {rowTitle(doc)}
                  {doc.labels.length > 0 && (
                    <span className="mt-0.5 flex flex-wrap gap-1">
                      {doc.labels.slice(0, 4).map((item) => (
                        <span
                          key={item}
                          className="rounded-full border border-outline-variant px-1.5 text-xs text-outline"
                        >
                          {item}
                        </span>
                      ))}
                    </span>
                  )}
                </button>
                <span className="hidden shrink-0 pt-1 text-xs text-outline sm:block">
                  {shortDate(doc.updated_at)}
                </span>
                <span className="hidden w-10 shrink-0 pt-1 text-right text-xs text-outline tabular-nums sm:block">
                  {doc.reads || ""}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] table-fixed text-sm">
              <thead>
                <tr className="border-b border-outline-variant text-left text-xs text-outline">
                  <th className="w-8 py-1">
                    <input
                      type="checkbox"
                      aria-label="Select all displayed documents"
                      checked={selection.allSelected}
                      onChange={() =>
                        selection.allSelected ? selection.clear() : selection.selectAll()
                      }
                      className="size-4 accent-primary"
                    />
                  </th>
                  <th className="py-1 pr-3 font-normal" aria-sort={ariaSort(sort, "title")}>
                    {header("title", "Title")}
                  </th>
                  <th className="hidden w-[26%] py-2 pr-3 font-normal md:table-cell">Labels</th>
                  <th
                    className="w-24 py-1 pr-3 font-normal sm:w-28"
                    aria-sort={ariaSort(sort, "updated")}
                  >
                    {header("updated", "Updated")}
                  </th>
                  <th
                    className="hidden w-16 py-1 text-right font-normal sm:table-cell"
                    aria-sort={ariaSort(sort, "reads")}
                  >
                    {header("reads", "Reads")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((doc) => (
                  <tr
                    key={doc.id}
                    data-testid="kb-document-table-row"
                    data-document-title={doc.title}
                    className="border-b border-outline-variant/60 align-top hover:bg-surface-high"
                  >
                    <td className="py-2">
                      <input
                        type="checkbox"
                        aria-label={`Select ${doc.title}`}
                        className="size-4 accent-primary"
                        checked={selection.selectedIds.includes(doc.id)}
                        onChange={() => selection.toggle(doc.id)}
                      />
                    </td>
                    <td className="min-w-0 py-2 pr-3">
                      <button
                        type="button"
                        data-testid="kb-document-row"
                        data-document-title={doc.title}
                        className="w-full text-left"
                        onClick={() => onOpen(doc.id)}
                      >
                        {rowTitle(doc)}
                        {doc.labels.length > 0 && (
                          <span className="mt-0.5 flex flex-wrap gap-1 md:hidden">
                            {doc.labels.slice(0, 3).map((item) => (
                              <span key={item} className="text-xs text-outline">
                                {item}
                              </span>
                            ))}
                          </span>
                        )}
                      </button>
                    </td>
                    <td className="hidden py-2 pr-3 text-xs text-outline md:table-cell">
                      <span className="line-clamp-2">{doc.labels.join(", ")}</span>
                    </td>
                    <td className="py-2 pr-3 text-xs text-outline tabular-nums">
                      {shortDate(doc.updated_at)}
                    </td>
                    <td className="hidden py-2 text-right text-xs text-outline tabular-nums sm:table-cell">
                      {doc.reads || ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-outline">Drop files anywhere on this page to upload.</p>
      </section>

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${selection.selectedIds.length} document${selection.selectedIds.length === 1 ? "" : "s"}?`}
        description="Deleting removes the documents and their revision history. This cannot be undone."
        isPending={busy}
        confirmLabel="Delete"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          void runBulk({ ids: selection.selectedIds, action: "delete" });
        }}
      />
    </div>
  );
}

function Shelf({
  title,
  hint,
  onMore,
  children,
}: {
  title: string;
  hint?: string;
  onMore: () => void;
  children: ReactNode;
}) {
  return (
    <section
      className="min-w-0 space-y-1"
      data-testid={`kb-shelf-${title.toLowerCase().split(" ")[0]}`}
    >
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-medium text-outline">{title}</h2>
        {hint && <span className="text-xs text-outline">{hint}</span>}
        <button
          type="button"
          className="ml-auto text-xs text-primary hover:underline"
          onClick={onMore}
        >
          View all
        </button>
      </div>
      <ul className="divide-y divide-outline-variant/60">{children}</ul>
    </section>
  );
}

function ShelfRow({
  doc,
  detail,
  onOpen,
}: {
  doc: Row;
  detail: string;
  onOpen: (id: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        data-testid="kb-shelf-row"
        className="flex min-h-9 w-full items-center gap-2 text-left hover:bg-surface-high"
        onClick={() => onOpen(doc.id)}
      >
        <FilePlus size={13} className="shrink-0 text-outline" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{doc.title}</span>
          <span className="block truncate font-mono text-xs text-outline">{doc.path}</span>
        </span>
        <span className="shrink-0 text-xs text-outline">{detail}</span>
      </button>
    </li>
  );
}

function BulkLabel({ onApply }: { onApply: (labels: string[]) => void }) {
  const [value, setValue] = useState("");
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" data-testid="kb-bulk-label">
          <Tag size={14} /> Label
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 space-y-2 p-3">
        <Label htmlFor="kb-bulk-label-input" className="text-xs">
          Add labels
        </Label>
        <Input
          id="kb-bulk-label-input"
          data-testid="kb-bulk-label-input"
          value={value}
          placeholder="release, ops"
          onChange={(event) => setValue(event.target.value)}
        />
        <Button
          size="sm"
          disabled={!value.trim()}
          onClick={() =>
            onApply(
              value
                .split(/[, ]+/)
                .map((label) => label.trim())
                .filter(Boolean),
            )
          }
        >
          Add
        </Button>
      </PopoverContent>
    </Popover>
  );
}

function MoveFolder({ onApply }: { onApply: (folder: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" data-testid="kb-bulk-move">
          <FolderInput size={14} /> Move
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 space-y-2 p-3">
        <Label htmlFor="kb-bulk-move-input" className="text-xs">
          Move to folder
        </Label>
        <Input
          id="kb-bulk-move-input"
          data-testid="kb-bulk-move-input"
          value={value}
          placeholder="guides (empty for root)"
          onChange={(event) => setValue(event.target.value)}
        />
        <Button size="sm" onClick={() => onApply(value.trim())}>
          Move
        </Button>
      </PopoverContent>
    </Popover>
  );
}

/** Shown only when a document needs action; a healthy knowledge base spends no space on it. */
function Attention({ kbId, onOpen }: { kbId: string; onOpen: (documentId: string) => void }) {
  const m = useMaintenance(kbId);
  if (!m || !(m.stale.length || m.failed.length || m.unresolved_links.length)) return null;
  return (
    <section data-testid="kb-maintenance" className="space-y-1 text-sm">
      <h2 className="text-sm font-medium text-outline">Needs attention</h2>
      <ul className="space-y-1">
        {m.failed.map((doc) => (
          <li key={doc.id}>
            <button
              type="button"
              className="text-left text-error hover:underline"
              onClick={() => onOpen(doc.id)}
            >
              Parsing failed: {doc.title}
            </button>
          </li>
        ))}
        {m.stale.map((doc) => (
          <li key={doc.id}>
            <button
              type="button"
              className="text-left text-warning hover:underline"
              onClick={() => onOpen(doc.id)}
            >
              Stale summary: {doc.title}
            </button>
          </li>
        ))}
        {m.unresolved_links.map((link) => (
          <li key={`${link.document_id}-${link.target}`}>
            <button
              type="button"
              className="text-left text-outline hover:underline"
              onClick={() => onOpen(link.document_id)}
            >
              [[{link.target}]] in {link.title} has no target
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function useMaintenance(kbId: string) {
  return useKbMaintenance(kbId).data;
}
