import type { WikiScope } from "@orc/sdk/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "@/api/client";
import { confirmDocumentClose, DocumentWorkspace } from "@/components/DocumentWorkspace";
import { KnowledgeNotebook } from "@/components/KnowledgeNotebook";
import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ViewHeader } from "@/components/ViewHeader";
import { useProjectScope } from "@/hooks/useProjectScope";
import { workspaceDestination } from "@/lib/workspace-navigation";

export default function Wiki({ projectId }: { projectId: string }) {
  const location = useLocation();
  const selectedProject = useProjectScope(projectId);
  const scope: WikiScope =
    selectedProject === "all" || selectedProject === "unassigned"
      ? { scope: "global" }
      : { project_id: selectedProject };
  const [params] = useSearchParams();
  const navigate = useNavigate();
  function setParams(update: (previous: URLSearchParams) => URLSearchParams): void {
    const next = update(new URLSearchParams(window.location.search));
    if (next.toString() === new URLSearchParams(window.location.search).toString()) return;
    navigate({ pathname: "/knowledge/wiki", search: next.toString(), hash: window.location.hash });
  }
  const requestedTab = params.get("tab");
  const legacyHistory = requestedTab === "changes" || requestedTab === "audit";
  const historyOpen = params.get("history") === "1" || legacyHistory;
  const auditOpen = params.get("audit") === "1" || requestedTab === "audit";
  const historyPage = params.get("historyPage") ?? (legacyHistory ? params.get("page") : null);
  const slug = params.get("page");
  const pageScope: WikiScope = params.get("scope") === "global" ? { scope: "global" } : scope;
  const queryClient = useQueryClient();
  const documentId = `wiki:${pageScope.project_id ?? "global"}:${slug}`;
  const pages = useQuery({
    queryKey: ["wiki", scope, "history-index"],
    queryFn: () => api.wiki.list(scope).then((r) => r.pages),
  });
  const changes = useQuery({
    queryKey: ["wiki-changes", scope],
    queryFn: () => api.wiki.changes(scope),
  });
  const audit = useQuery({
    queryKey: ["knowledge-audit", scope],
    queryFn: () => api.audit.list(scope),
    enabled: historyOpen,
  });
  const page = useQuery({
    queryKey: ["wiki-page", slug, pageScope],
    queryFn: () => api.wiki.get(slug as string, pageScope),
    enabled: Boolean(slug),
  });
  const history = useQuery({
    queryKey: ["wiki-history", slug, pageScope],
    queryFn: () => api.wiki.history(slug as string, pageScope),
    enabled: Boolean(slug),
  });
  function selectPage(nextSlug: string, owner: string | null): void {
    if (nextSlug === slug && historyPage === nextSlug && owner === (pageScope.project_id ?? null))
      return;
    if (!confirmDocumentClose(documentId)) return;
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set("page", nextSlug);
      next.set("historyPage", nextSlug);
      if (owner === null) next.set("scope", "global");
      else next.delete("scope");
      return next;
    });
  }
  const error = pages.error ?? changes.error ?? audit.error;
  return (
    <div data-testid="wiki-view">
      <ViewHeader
        title="Wiki"
        action={
          <Button
            variant="outline"
            data-testid="wiki-history-toggle"
            aria-pressed={historyOpen}
            onClick={() => {
              if (!confirmDocumentClose(documentId)) return;
              setParams((previous) => {
                const next = new URLSearchParams(previous);
                next.delete("tab");
                next.delete("historyPage");
                if (historyOpen) next.delete("history");
                else next.set("history", "1");
                return next;
              });
            }}
          >
            {historyOpen ? "Back to Wiki" : "History"}
          </Button>
        }
      />
      {error && <p role="alert">{(error as Error).message}</p>}
      {historyOpen && (
        <div className="space-y-2" data-testid="wiki-history-feed">
          <h2 className="text-lg font-medium">History</h2>
          <p className="text-sm text-muted-foreground">Recent changes to your Wiki pages.</p>
          {changes.isLoading && <p>Loading learning history...</p>}
          {changes.data?.changes.length === 0 && (
            <p className="text-muted-foreground text-sm">No lessons recorded in this scope yet.</p>
          )}
          {changes.data?.changes.map((change) => (
            <button
              key={`${change.project_id ?? "global"}:${change.slug}:${change.revision}`}
              type="button"
              data-testid="wiki-change"
              className="w-full text-left border-b border-outline-variant p-4 hover:bg-surface-low"
              onClick={() => selectPage(change.slug, change.project_id)}
            >
              <div className="font-medium text-sm">
                {change.title}{" "}
                <span className="text-muted-foreground">· revision {change.revision}</span>
              </div>
              <p className="text-xs my-2">{change.note}</p>
              <div className="text-xs text-muted-foreground">
                {change.author} · {new Date(change.updated_at * 1000).toLocaleString()} ·{" "}
                {change.project_id ? "Project" : "Global"}
                {change.session_id && ` · session ${change.session_id}`}
              </div>
            </button>
          ))}
        </div>
      )}
      {!historyOpen && <KnowledgeNotebook key={selectedProject} projectId={selectedProject} />}
      {historyOpen && (
        <details
          className="mt-6 space-y-2"
          data-testid="wiki-technical-audit"
          open={auditOpen}
          onToggle={(event) => {
            const open = event.currentTarget.open;
            if (open === auditOpen) return;
            setParams((previous) => {
              const next = new URLSearchParams(previous);
              next.delete("tab");
              next.set("history", "1");
              if (open) next.set("audit", "1");
              else next.delete("audit");
              return next;
            });
          }}
        >
          <summary className="cursor-pointer text-sm text-muted-foreground">
            Technical audit details
          </summary>
          {audit.isLoading && <p>Loading audit log...</p>}
          {audit.data?.entries.length === 0 && <p>No knowledge actions recorded.</p>}
          {audit.data?.entries.map((entry) => (
            <details
              key={entry.id}
              data-testid="wiki-audit-entry"
              className="border-b border-outline-variant p-3"
            >
              <summary className="text-sm cursor-pointer">
                {entry.action} · {entry.subject_ids.join(", ")} · {entry.actor ?? "unknown"} ·{" "}
                {new Date(entry.created_at * 1000).toLocaleString()}
              </summary>
              <p className="text-xs my-2">{entry.note}</p>
              <p className="text-xs">Replacement IDs: {entry.result_ids.join(", ") || "—"}</p>
              <pre className="text-xs whitespace-pre-wrap break-all mt-2">
                {JSON.stringify(entry.snapshot, null, 2)}
              </pre>
            </details>
          ))}
        </details>
      )}
      <Sheet
        open={Boolean(historyPage) && historyOpen}
        onOpenChange={(open) => {
          if (!open && confirmDocumentClose(documentId))
            setParams((previous) => {
              const next = new URLSearchParams(previous);
              next.delete("historyPage");
              next.delete("tab");
              next.set("history", "1");
              return next;
            });
        }}
      >
        <SheetContent className="w-screen max-w-full sm:w-[1120px] sm:max-w-[96vw]">
          <SheetHeader>
            <SheetTitle>{page.data?.title ?? "Wiki page"}</SheetTitle>
          </SheetHeader>
          <SheetBody>
            {page.error && <p role="alert">{(page.error as Error).message}</p>}
            {page.isLoading && <p>Loading page...</p>}
            {page.data && (
              <div data-testid="wiki-page-content" className="space-y-4">
                <p className="text-xs text-muted-foreground">
                  Revision {page.data.revision} · {page.data.author} ·{" "}
                  {page.data.project_id ? "Project" : "Global"}
                </p>
                <DocumentWorkspace
                  key={documentId}
                  documentId={documentId}
                  path={`${page.data.slug}.md`}
                  content={page.data.content}
                  testId="wiki-editor-content"
                  onSave={async (content, expectedContent) => {
                    const current = page.data;
                    if (!current || current.content !== expectedContent)
                      throw new Error(
                        "This page changed since it was opened. Reopen it before saving.",
                      );
                    const saved = await api.wiki
                      .write({
                        project_id: current.project_id,
                        slug: current.slug,
                        kind: current.kind,
                        title: current.title,
                        summary: current.summary,
                        tags: current.tags,
                        sources: current.sources,
                        expected_revision: current.revision,
                        content,
                        author: "human",
                        note: "Manual Markdown edit",
                      })
                      .catch(async (error: unknown) => {
                        await page.refetch();
                        throw error;
                      });
                    await queryClient.invalidateQueries({ queryKey: ["wiki-page"] });
                    await queryClient.invalidateQueries({ queryKey: ["wiki-history"] });
                    await queryClient.invalidateQueries({ queryKey: ["wiki"] });
                    await queryClient.invalidateQueries({ queryKey: ["wiki-changes"] });
                    return saved.content;
                  }}
                  wikiLinks={{
                    slugs: (pages.data ?? []).map((entry) => entry.slug),
                    select: (next) => {
                      const target = pages.data?.find((entry) => entry.slug === next);
                      if (target) selectPage(next, target.project_id);
                    },
                  }}
                />
                <div>
                  <h3 className="text-xs font-medium">Sources</h3>
                  <ul className="text-xs break-all">
                    {page.data.sources.map((source) => (
                      <li key={source}>
                        {source.startsWith("memory:") ? (
                          <Link
                            className="text-primary underline"
                            to={workspaceDestination(
                              `/knowledge/memories/${encodeURIComponent(source.slice(7))}`,
                              selectedProject,
                              location.search,
                            )}
                          >
                            {source}
                          </Link>
                        ) : (
                          source
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
            <h3 className="text-sm font-medium mt-6 mb-3">Revision history</h3>
            {history.error && <p role="alert">{(history.error as Error).message}</p>}
            {history.data?.revisions.map((revision) => (
              <details
                key={revision.revision}
                data-testid="wiki-revision"
                className="border-b border-outline-variant p-3 mb-2"
              >
                <summary className="text-xs cursor-pointer">
                  Revision {revision.revision} · {revision.note} · {revision.author}
                </summary>
                <p className="text-xs text-muted-foreground mt-2">
                  Source session: {revision.session_id ?? "unknown"}
                </p>
                <Markdown>{revision.content}</Markdown>
              </details>
            ))}
          </SheetBody>
        </SheetContent>
      </Sheet>
    </div>
  );
}
