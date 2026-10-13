import type { WikiScope } from "@orc/sdk/types";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "@/api/client";
import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ViewHeader } from "@/components/ViewHeader";
import { useProjectScope } from "@/hooks/useProjectScope";

export default function Wiki({ projectId }: { projectId: string }) {
  const selectedProject = useProjectScope(projectId);
  const scope: WikiScope =
    selectedProject === "all" || selectedProject === "unassigned"
      ? { scope: "global" }
      : { project_id: selectedProject };
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "changes";
  const slug = params.get("page");
  const pageScope: WikiScope = params.get("scope") === "global" ? { scope: "global" } : scope;
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const pages = useQuery({
    queryKey: ["wiki", scope, query],
    queryFn: () =>
      query
        ? api.wiki.search(query, scope).then((r) => r.results)
        : api.wiki.list(scope).then((r) => r.pages),
    refetchInterval: 30000,
  });
  const changes = useQuery({
    queryKey: ["wiki-changes", scope],
    queryFn: () => api.wiki.changes(scope),
    refetchInterval: 30000,
  });
  const audit = useQuery({
    queryKey: ["knowledge-audit", scope],
    queryFn: () => api.audit.list(scope),
    enabled: tab === "audit",
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
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set("page", nextSlug);
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
        meta={scope.scope === "global" ? "Global lessons" : "Project lessons with global fallback"}
      />
      <div className="flex gap-2 mb-5">
        {[
          ["changes", "What ORC learned"],
          ["pages", "Pages"],
          ["audit", "Audit log"],
        ].map(([value, label]) => (
          <Button
            key={value}
            data-testid={`wiki-tab-${value}`}
            variant={tab === value ? "default" : "outline"}
            onClick={() =>
              setParams((previous) => {
                const next = new URLSearchParams(previous);
                next.set("tab", value);
                return next;
              })
            }
          >
            {label}
          </Button>
        ))}
      </div>
      {error && <p role="alert">{(error as Error).message}</p>}
      {tab === "changes" && (
        <div className="space-y-2">
          {changes.isLoading && <p>Loading learning history...</p>}
          {changes.data?.changes.length === 0 && (
            <p className="text-outline text-sm">No lessons recorded in this scope yet.</p>
          )}
          {changes.data?.changes.map((change) => (
            <button
              key={`${change.project_id ?? "global"}:${change.slug}:${change.revision}`}
              type="button"
              data-testid="wiki-change"
              className="w-full text-left border border-surface-highest rounded-sm p-4 hover:bg-surface-low"
              onClick={() => selectPage(change.slug, change.project_id)}
            >
              <div className="font-semibold text-sm">
                {change.title} <span className="text-outline">· revision {change.revision}</span>
              </div>
              <p className="text-xs my-2">{change.note}</p>
              <div className="text-xs text-outline">
                {change.author} · {new Date(change.updated_at * 1000).toLocaleString()} ·{" "}
                {change.project_id ? "Project" : "Global"}
                {change.session_id && ` · session ${change.session_id}`}
              </div>
            </button>
          ))}
        </div>
      )}
      {tab === "pages" && (
        <div>
          <form
            className="flex gap-2 mb-4"
            onSubmit={(event) => {
              event.preventDefault();
              setQuery(input.trim());
            }}
          >
            <Input
              data-testid="wiki-search-input"
              aria-label="Search wiki"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Search lessons and procedures..."
            />
            <Button data-testid="wiki-search-submit" type="submit">
              Search
            </Button>
          </form>
          {pages.isLoading && <p>Loading pages...</p>}
          {pages.data?.length === 0 && <p className="text-outline text-sm">No matching pages.</p>}
          <div className="space-y-2">
            {pages.data?.map((entry) => (
              <button
                type="button"
                key={`${entry.project_id}:${entry.slug}`}
                data-testid="wiki-page-row"
                data-slug={entry.slug}
                className="w-full text-left border border-surface-highest p-4 rounded-sm hover:bg-surface-low"
                onClick={() => selectPage(entry.slug, entry.project_id)}
              >
                <div className="font-semibold text-sm">{entry.title}</div>
                <p className="text-xs mt-2">{entry.summary}</p>
                <span className="text-xs text-outline">
                  {entry.kind} · {entry.project_id ? "Project" : "Global"}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      {tab === "audit" && (
        <div className="space-y-2">
          {audit.isLoading && <p>Loading audit log...</p>}
          {audit.data?.entries.length === 0 && <p>No knowledge actions recorded.</p>}
          {audit.data?.entries.map((entry) => (
            <details
              key={entry.id}
              data-testid="wiki-audit-entry"
              className="border border-surface-highest p-3 rounded-sm"
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
        </div>
      )}
      <Sheet
        open={Boolean(slug)}
        onOpenChange={(open) => {
          if (!open)
            setParams((previous) => {
              const next = new URLSearchParams(previous);
              next.delete("page");
              next.delete("scope");
              return next;
            });
        }}
      >
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{page.data?.title ?? "Wiki page"}</SheetTitle>
          </SheetHeader>
          <SheetBody>
            {page.error && <p role="alert">{(page.error as Error).message}</p>}
            {page.isLoading && <p>Loading page...</p>}
            {page.data && (
              <div data-testid="wiki-page-content" className="space-y-4">
                <p className="text-xs text-outline">
                  Revision {page.data.revision} · {page.data.author} ·{" "}
                  {page.data.project_id ? "Project" : "Global"}
                </p>
                <Markdown
                  wikiLinks={{
                    slugs: (pages.data ?? []).map((entry) => entry.slug),
                    select: (next) => {
                      const target = pages.data?.find((entry) => entry.slug === next);
                      if (target) selectPage(next, target.project_id);
                    },
                  }}
                >
                  {page.data.content}
                </Markdown>
                <div>
                  <h3 className="text-xs font-semibold">Sources</h3>
                  <ul className="text-xs break-all">
                    {page.data.sources.map((source) => (
                      <li key={source}>
                        {source.startsWith("memory:") ? (
                          <a
                            className="text-primary underline"
                            href={`/memories/${encodeURIComponent(source.slice(7))}`}
                          >
                            {source}
                          </a>
                        ) : (
                          source
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
            <h3 className="text-sm font-semibold mt-6 mb-3">Revision history</h3>
            {history.error && <p role="alert">{(history.error as Error).message}</p>}
            {history.data?.revisions.map((revision) => (
              <details
                key={revision.revision}
                data-testid="wiki-revision"
                className="border border-surface-highest p-3 mb-2 rounded-sm"
              >
                <summary className="text-xs cursor-pointer">
                  Revision {revision.revision} · {revision.note} · {revision.author}
                </summary>
                <p className="text-xs text-outline mt-2">
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
