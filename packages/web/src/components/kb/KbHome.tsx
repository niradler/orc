import type { KbDocumentListing, KnowledgeBase } from "@orc/core/kb";
import { ArrowDown, ArrowUp, FilePlus, FolderSync, Settings, Upload } from "lucide-react";
import { useState } from "react";
import { HelpPopover } from "@/components/HelpPopover";
import { KbComments } from "@/components/kb/KbComments";
import { SOURCE_LABELS } from "@/components/kb/KbDialogs";
import { KbDigestSection } from "@/components/kb/KbDigest";
import { KbFolders } from "@/components/kb/KbFolders";
import { KbSetupRow, StateDot } from "@/components/kb/KbSetupRow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useKbMaintenance, useKbParsers } from "@/hooks/useKnowledge";
import { cn } from "@/lib/utils";

/** Label pills shown before "more"; the rest stay one click away. */
const LABEL_LIMIT = 8;

type SortKey = "title" | "updated" | "reads";
type Sort = { key: SortKey; desc: boolean };

function compare(a: KbDocumentListing["documents"][number], b: typeof a, key: SortKey): number {
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

/** A knowledge base's front page: what it is, how it is set up, and its documents. */
export function KbHome({
  kb,
  owner,
  listing,
  label,
  onLabel,
  onOpen,
  onNewDocument,
  onSettings,
}: {
  kb: KnowledgeBase;
  owner: string;
  listing: KbDocumentListing | undefined;
  label: string;
  onLabel: (label: string | null) => void;
  onOpen: (documentId: string) => void;
  onNewDocument: () => void;
  onSettings: () => void;
}) {
  const agentsEdit = kb.editable_by.includes("mcp");
  return (
    <div data-testid="kb-overview" className="w-full min-w-0 space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="wrap-break-word text-base font-medium" data-testid="kb-overview-name">
            {kb.name}
          </h2>
          {kb.description && <p className="max-w-prose text-outline">{kb.description}</p>}
          <p className="text-xs text-outline" data-testid="kb-overview-meta">
            {owner} · {kb.document_count} {kb.document_count === 1 ? "document" : "documents"} ·{" "}
            {agentsEdit ? "agents can edit" : "agents read only"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" data-testid="kb-new-document" onClick={onNewDocument}>
            <FilePlus size={16} />
            New document
          </Button>
          <Button size="sm" variant="ghost" data-testid="kb-settings" onClick={onSettings}>
            <Settings size={16} />
            Settings
          </Button>
        </div>
      </header>

      <Attention kbId={kb.id} onOpen={onOpen} />

      <DocumentTable
        listing={listing}
        total={kb.document_count}
        label={label}
        onLabel={onLabel}
        onOpen={onOpen}
        onNewDocument={onNewDocument}
      />

      <section aria-labelledby="kb-setup-heading" className="space-y-1">
        <h3 id="kb-setup-heading" className="text-sm font-medium text-outline">
          Setup
        </h3>
        <div className="divide-y divide-outline-variant border-y border-outline-variant">
          <KbDigestSection kb={kb} />
          <KbFolders kb={kb} />
          <AccessRow kb={kb} onSettings={onSettings} />
          <UploadsRow kb={kb} onSettings={onSettings} />
          <KbComments kbId={kb.id} onOpenDocument={onOpen} />
        </div>
      </section>
    </div>
  );
}

/** Who may change documents; reading and search are open to every source. */
function AccessRow({ kb, onSettings }: { kb: KnowledgeBase; onSettings: () => void }) {
  const agentsEdit = kb.editable_by.includes("mcp");
  return (
    <KbSetupRow
      title="Who can edit"
      testId="kb-access"
      summary={
        <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5">
          <StateDot tone={agentsEdit ? "ok" : "off"} />
          {agentsEdit ? "Agents can edit" : "Agents read only"}
          <span className="text-outline">
            ·{" "}
            {kb.editable_by.length
              ? kb.editable_by.map((s) => SOURCE_LABELS[s]).join(", ")
              : "nobody, read only everywhere"}
          </span>
        </span>
      }
      actions={
        <Button size="sm" variant="ghost" data-testid="kb-access-change" onClick={onSettings}>
          Change
        </Button>
      }
    />
  );
}

/** Which parser turns uploaded files into Markdown. */
function UploadsRow({ kb, onSettings }: { kb: KnowledgeBase; onSettings: () => void }) {
  const parsers = useKbParsers();
  const chosen = kb.parser
    ? (parsers.data?.parsers.find((p) => p.id === kb.parser)?.label ?? kb.parser)
    : "Workspace default parser";
  return (
    <KbSetupRow
      title="Uploads"
      testId="kb-uploads-setup"
      summary={
        <span className="text-outline" data-testid="kb-uploads-parser">
          {chosen}
          <HelpPopover label="Document uploads">
            PDF, Word, PowerPoint, Excel, HTML, Markdown and text are converted to searchable
            Markdown by the selected parser.
          </HelpPopover>
        </span>
      }
      actions={
        <Button size="sm" variant="ghost" data-testid="kb-parser-change" onClick={onSettings}>
          Change
        </Button>
      }
    />
  );
}

function DocumentTable({
  listing,
  total,
  label,
  onLabel,
  onOpen,
  onNewDocument,
}: {
  listing: KbDocumentListing | undefined;
  total: number;
  label: string;
  onLabel: (label: string | null) => void;
  onOpen: (documentId: string) => void;
  onNewDocument: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [allLabels, setAllLabels] = useState(false);
  const [sort, setSort] = useState<Sort>({ key: "updated", desc: true });
  const needle = filter.trim().toLowerCase();
  const rows = (listing?.documents ?? [])
    .filter(
      (d) =>
        (!label || d.labels.includes(label)) &&
        (!needle ||
          d.title.toLowerCase().includes(needle) ||
          d.path.toLowerCase().includes(needle) ||
          d.labels.some((l) => l.toLowerCase().includes(needle))),
    )
    .sort((a, b) => compare(a, b, sort.key) * (sort.desc ? -1 : 1));
  function sortBy(key: SortKey): void {
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== "title" }));
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
  const sorted = [...(listing?.labels ?? [])].sort((a, b) => b.count - a.count);
  const shown = allLabels ? sorted : sorted.filter((l, i) => i < LABEL_LIMIT || l.label === label);
  const hidden = sorted.length - shown.length;
  return (
    <section
      aria-labelledby="kb-documents-heading"
      data-testid="kb-documents"
      className="space-y-3"
    >
      <div className="flex flex-wrap items-center gap-3">
        <h3 id="kb-documents-heading" className="mr-auto text-sm font-medium text-outline">
          Documents{label ? ` labelled ${label}` : ""}
        </h3>
        {total > 0 && (
          <Input
            aria-label="Filter documents"
            data-testid="kb-documents-filter"
            placeholder="Filter by title, path or label"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-9 w-full sm:w-64"
          />
        )}
      </div>
      {shown.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="kb-labels">
          <span className="mr-1 text-xs text-outline">Label</span>
          {shown.map((l) => (
            <button
              type="button"
              key={l.label}
              data-testid="kb-label-filter"
              aria-pressed={label === l.label}
              className={cn(
                "min-h-8 rounded-full border px-2.5 text-xs",
                label === l.label
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-outline-variant text-outline hover:text-on-surface",
              )}
              onClick={() => onLabel(label === l.label ? null : l.label)}
            >
              {l.label} <span className="tabular-nums">{l.count}</span>
            </button>
          ))}
          {(hidden > 0 || allLabels) && sorted.length > LABEL_LIMIT && (
            <button
              type="button"
              data-testid="kb-labels-more"
              className="min-h-8 px-2 text-xs text-primary hover:underline"
              onClick={() => setAllLabels(!allLabels)}
            >
              {allLabels ? "Fewer labels" : `${hidden} more`}
            </button>
          )}
        </div>
      )}
      {total === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-outline-variant px-6 py-10 text-center text-sm text-outline">
          <Upload size={22} className="text-primary" aria-hidden />
          <span>
            This knowledge base is empty. Drop PDF, Word, PowerPoint, Excel, HTML, Markdown or text
            files here, or
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
      ) : (
        <>
          {rows.length === 0 && listing && (
            <p className="py-4 text-sm text-outline" data-testid="kb-documents-empty">
              No documents match.{" "}
              <button
                type="button"
                data-testid="kb-documents-clear"
                className="text-primary hover:underline"
                onClick={() => {
                  setFilter("");
                  onLabel(null);
                }}
              >
                Clear filters
              </button>
            </p>
          )}
          {rows.length > 0 && (
            <table className="w-full table-fixed text-sm">
              <thead>
                <tr className="border-b border-outline-variant text-left text-xs text-outline">
                  <th className="py-1 pr-3 font-normal" aria-sort={ariaSort(sort, "title")}>
                    {header("title", "Title")}
                  </th>
                  <th className="hidden w-[30%] py-2 pr-3 font-normal md:table-cell">Labels</th>
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
                {rows.map((d) => (
                  <tr
                    key={d.id}
                    className="cursor-pointer border-b border-outline-variant/60 align-top hover:bg-surface-high"
                    onClick={() => onOpen(d.id)}
                  >
                    <td className="min-w-0 py-2 pr-3">
                      <button
                        type="button"
                        data-testid="kb-document-row"
                        data-document-title={d.title}
                        className="flex w-full min-w-0 items-center gap-1.5 text-left font-medium hover:text-primary"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpen(d.id);
                        }}
                      >
                        <span className="min-w-0 truncate">{d.title}</span>
                        {d.origin === "external" && (
                          <FolderSync
                            size={13}
                            className="shrink-0 text-outline"
                            aria-label="From a synced folder"
                          />
                        )}
                      </button>
                      <span className="block truncate font-mono text-xs text-outline">
                        {d.path}
                      </span>
                      {(d.parse_state === "pending" || d.parse_state === "failed") && (
                        <span
                          className={cn(
                            "text-xs",
                            d.parse_state === "failed" ? "text-error" : "text-outline",
                          )}
                        >
                          {d.parse_state === "failed" ? "Parsing failed" : "Parsing…"}
                        </span>
                      )}
                    </td>
                    <td className="hidden py-2 pr-3 text-xs text-outline md:table-cell">
                      <span className="line-clamp-2">{d.labels.join(", ")}</span>
                    </td>
                    <td className="py-2 pr-3 text-xs text-outline tabular-nums">
                      {shortDate(d.updated_at)}
                    </td>
                    <td className="hidden py-2 text-right text-xs text-outline tabular-nums sm:table-cell">
                      {d.reads || ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="text-xs text-outline">Drop files anywhere on this page to upload.</p>
        </>
      )}
    </section>
  );
}

/** Shown only when a document needs action; a healthy knowledge base spends no space on it. */
function Attention({ kbId, onOpen }: { kbId: string; onOpen: (documentId: string) => void }) {
  const m = useKbMaintenance(kbId).data;
  if (!m || !(m.stale.length || m.failed.length || m.unresolved_links.length)) return null;
  return (
    <section data-testid="kb-maintenance" className="space-y-1 text-sm">
      <h3 className="text-sm font-medium text-outline">Needs attention</h3>
      <ul className="space-y-1">
        {m.failed.map((d) => (
          <li key={d.id}>
            <button
              type="button"
              className="text-left text-error hover:underline"
              onClick={() => onOpen(d.id)}
            >
              Parsing failed: {d.title}
            </button>
          </li>
        ))}
        {m.stale.map((d) => (
          <li key={d.id}>
            <button
              type="button"
              className="text-left text-warning hover:underline"
              onClick={() => onOpen(d.id)}
            >
              Stale summary: {d.title}
            </button>
          </li>
        ))}
        {m.unresolved_links.map((l) => (
          <li key={`${l.document_id}-${l.target}`}>
            <button
              type="button"
              className="text-left text-outline hover:underline"
              onClick={() => onOpen(l.document_id)}
            >
              [[{l.target}]] in {l.title} has no target
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
