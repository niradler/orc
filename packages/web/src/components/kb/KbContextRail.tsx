import type { KnowledgeBase } from "@orc/core/kb";
import { ArrowRight, Search } from "lucide-react";
import { KbComments } from "@/components/kb/KbComments";
import { SOURCE_LABELS } from "@/components/kb/KbDialogs";
import { KbDigestSection } from "@/components/kb/KbDigest";
import { KbFolders } from "@/components/kb/KbFolders";
import { KbSetupRow, StateDot } from "@/components/kb/KbSetupRow";
import { Button } from "@/components/ui/button";
import { useKbMaintenance, useKbParsers, useKbStatus } from "@/hooks/useKnowledge";

/** Home's context rail: health, setup demoted to Manage, and how search resolves. */
export function KbContextRail({
  kb,
  owner,
  onSettings,
  onSearch,
  onOpenDocument,
}: {
  kb: KnowledgeBase;
  owner: string;
  onSettings: () => void;
  onSearch: () => void;
  onOpenDocument: (documentId: string) => void;
}) {
  const maintenance = useKbMaintenance(kb.id).data;
  const status = useKbStatus().data;
  const agentsEdit = kb.editable_by.includes("mcp");
  const issues = maintenance
    ? maintenance.failed.length + maintenance.stale.length + maintenance.unresolved_links.length
    : 0;
  return (
    <aside
      data-testid="kb-context-rail"
      aria-label="Knowledge details"
      className="min-h-0 w-full space-y-5 overflow-y-auto p-4 text-sm xl:h-full"
    >
      <section className="space-y-2" aria-labelledby="kb-health-heading">
        <h2 id="kb-health-heading" className="text-sm font-medium text-outline">
          Knowledge health
        </h2>
        {!maintenance ? (
          <p className="text-xs text-outline">Checking…</p>
        ) : issues === 0 ? (
          <p className="flex items-center gap-1.5 text-xs text-outline">
            <StateDot tone="ok" /> Nothing needs attention
          </p>
        ) : (
          <ul className="space-y-1 text-xs">
            {maintenance.failed.length > 0 && (
              <li className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-error">
                  <StateDot tone="error" /> {maintenance.failed.length} parse failed
                </span>
              </li>
            )}
            {maintenance.stale.length > 0 && (
              <li className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 text-warning">
                  <StateDot tone="warning" /> {maintenance.stale.length} stale summary
                </span>
              </li>
            )}
            {maintenance.unresolved_links.length > 0 && (
              <li className="flex items-center justify-between gap-2 text-outline">
                <span className="inline-flex items-center gap-1.5">
                  <StateDot tone="off" /> {maintenance.unresolved_links.length} unresolved link
                </span>
              </li>
            )}
          </ul>
        )}
      </section>

      <section className="space-y-1" aria-labelledby="kb-manage-heading">
        <h2 id="kb-manage-heading" className="text-sm font-medium text-outline">
          Manage
        </h2>
        <div className="divide-y divide-outline-variant border-y border-outline-variant">
          <KbDigestSection kb={kb} compact />
          <KbFolders kb={kb} compact />
          <AccessRow kb={kb} onSettings={onSettings} />
          <UploadsRow kb={kb} onSettings={onSettings} />
          <KbComments kbId={kb.id} onOpenDocument={onOpenDocument} />
        </div>
      </section>

      <section className="space-y-2" aria-labelledby="kb-search-heading">
        <h2 id="kb-search-heading" className="text-sm font-medium text-outline">
          Search
        </h2>
        <p className="flex items-start gap-1.5 text-xs text-outline">
          <StateDot tone={status?.embedding.ready ? "ok" : "off"} />
          {status
            ? status.embedding.provider === "none"
              ? "Keyword search only. Add embeddings to search by meaning."
              : status.embedding.ready
                ? `Hybrid search ready. ${status.embedding.model ?? "Embeddings"} and keywords merge; labels narrow every path.`
                : "Embeddings are configured but not ready; keyword search still works."
            : "Search status unavailable."}
        </p>
        <Button size="sm" variant="ghost" onClick={onSearch} data-testid="kb-context-search">
          <Search size={14} /> Open search
          <ArrowRight size={14} />
        </Button>
      </section>

      <section className="space-y-1 border-t border-outline-variant pt-3 text-xs text-outline">
        <p>
          <span className="text-on-surface">{owner}</span> · {kb.document_count} documents
        </p>
        <p>
          {agentsEdit ? "Agents can edit" : "Agents read only"} ·{" "}
          {kb.editable_by.length
            ? kb.editable_by.map((source) => SOURCE_LABELS[source]).join(", ")
            : "nobody"}
        </p>
      </section>
    </aside>
  );
}

function AccessRow({ kb, onSettings }: { kb: KnowledgeBase; onSettings: () => void }) {
  const agentsEdit = kb.editable_by.includes("mcp");
  return (
    <KbSetupRow
      title="Who can edit"
      testId="kb-access"
      compact
      summary={
        <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5">
          <StateDot tone={agentsEdit ? "ok" : "off"} />
          {agentsEdit ? "Agents can edit" : "Agents read only"}
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

function UploadsRow({ kb, onSettings }: { kb: KnowledgeBase; onSettings: () => void }) {
  const parsers = useKbParsers();
  const chosen = kb.parser
    ? (parsers.data?.parsers.find((parser) => parser.id === kb.parser)?.label ?? kb.parser)
    : "Workspace default";
  return (
    <KbSetupRow
      title="Uploads"
      testId="kb-uploads-setup"
      compact
      summary={
        <span className="text-outline" data-testid="kb-uploads-parser">
          {chosen}
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
