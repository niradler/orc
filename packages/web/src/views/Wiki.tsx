import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client";
import { ErrorState } from "@/components/ErrorState";
import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function Wiki({ projectId }: { projectId?: string }) {
  const [selected, setSelected] = useState<string>();
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [citation, setCitation] = useState<string>();
  const cited = useQuery({
    queryKey: ["citation", projectId, citation],
    queryFn: () => api.evidence.get([citation ?? ""], projectId ?? null),
    enabled: Boolean(citation),
  });
  const wiki = useQuery({
    queryKey: ["wiki", projectId, selected],
    queryFn: () => api.wiki.read(projectId, selected),
    refetchInterval: 30000,
  });
  const retrieval = useQuery({
    queryKey: ["evidence", projectId, query],
    queryFn: () => api.evidence.search({ query, project_id: projectId ?? null }),
    enabled: Boolean(query.trim()),
  });
  if (wiki.error)
    return <ErrorState message={wiki.error.message} onRetry={() => void wiki.refetch()} />;
  const page = wiki.data?.pages.find((entry) => entry.slug === selected);
  return (
    <section data-testid="wiki-workspace" className="space-y-5">
      {!projectId && (
        <p className="text-sm text-outline">
          Select a project to view its wiki. Unassigned evidence is shown here.
        </p>
      )}
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(input);
        }}
      >
        <Input
          data-testid="wiki-search-input"
          aria-label="Search cited evidence"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Search sessions, lessons, and procedures"
        />
        <Button data-testid="wiki-search-submit" type="submit">
          Search evidence
        </Button>
      </form>
      {retrieval.error && <p role="alert">{retrieval.error.message}</p>}
      {retrieval.data && (
        <div data-testid="wiki-search-results" className="space-y-3">
          <p className="text-xs text-outline">
            Semantic retrieval: {retrieval.data.capabilities.semantic} ·{" "}
            {retrieval.data.estimated_tokens} estimated tokens
          </p>
          {retrieval.data.passages.map((passage) => (
            <article key={passage.id} className="border border-surface-highest p-3">
              <h3>
                {passage.title}
                {passage.headings.length ? ` / ${passage.headings.join(" / ")}` : ""}
              </h3>
              <pre className="whitespace-pre-wrap text-sm">{passage.content}</pre>
              <p className="text-xs text-outline break-all">
                {passage.location} · version {passage.version.slice(0, 12)} · offsets{" "}
                {passage.start}–{passage.end} · citation {passage.id}
              </p>
            </article>
          ))}
          {!retrieval.data.passages.length && <p>No current evidence matched within the budget.</p>}
        </div>
      )}
      <div className="flex gap-2 flex-wrap">
        {wiki.data?.pages.map((entry) => (
          <Button
            key={entry.slug}
            data-testid={`wiki-page-${entry.slug}`}
            variant={entry.slug === selected ? "default" : "outline"}
            onClick={() => setSelected(entry.slug)}
          >
            {entry.title}
          </Button>
        ))}
      </div>
      {page && (
        <article
          data-testid="wiki-page-content"
          className="border border-surface-highest p-4 space-y-3"
        >
          <h2>
            {page.title} · revision {page.revision}
          </h2>
          <Markdown
            wikiLinks={{
              slugs: wiki.data?.pages.map((entry) => entry.slug) ?? [],
              select: setSelected,
            }}
          >
            {page.content}
          </Markdown>
          <div className="flex flex-wrap gap-2">
            {page.evidence.map((id) => (
              <Button
                key={id}
                variant="outline"
                size="sm"
                data-testid="wiki-citation"
                onClick={() => setCitation(id)}
              >
                Read evidence {id.slice(0, 12)}
              </Button>
            ))}
          </div>
          <details>
            <summary>Revision history</summary>
            {wiki.data?.history.map((revision) => (
              <div key={revision.revision} className="my-3">
                <p>
                  Revision {revision.revision}: {revision.summary}
                </p>
                <pre className="whitespace-pre-wrap text-sm">{revision.content}</pre>
              </div>
            ))}
          </details>
        </article>
      )}
      {cited.error && <p role="alert">{cited.error.message}</p>}
      {cited.data?.passages.map((passage) => (
        <article
          key={passage.id}
          data-testid="wiki-cited-source"
          className="border border-surface-highest p-3"
        >
          <h3>{passage.title} · immutable source evidence</h3>
          <pre className="whitespace-pre-wrap text-sm">{passage.content}</pre>
          <p className="text-xs break-all">
            {passage.location} · version {passage.version} · offsets {passage.start}–{passage.end}
          </p>
        </article>
      ))}
      {!wiki.data?.pages.length && (
        <p>
          No maintained pages yet. Completed work contributes evidence; the agent loop consolidates
          queued contributions.
        </p>
      )}
      <details open>
        <summary>Session contributions</summary>
        <ul className="space-y-2 mt-3">
          {wiki.data?.contributions.map((contribution) => (
            <li key={contribution.id} data-testid="wiki-contribution" className="text-sm">
              {contribution.source_id} · {contribution.status} · attempts {contribution.attempts}/3
              {contribution.summary ? ` · ${contribution.summary}` : ""}
              <details>
                <summary>Processing history</summary>
                <ul data-testid="wiki-attempt-history" className="ml-4 space-y-1">
                  {wiki.data?.attempts
                    .filter((attempt) => attempt.contribution_id === contribution.id)
                    .map((attempt) => (
                      <li key={attempt.id}>
                        {attempt.outcome}: {attempt.summary}
                      </li>
                    ))}
                </ul>
              </details>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
