import type { WikiIndexEntry, WikiPage, WikiScope } from "@orc/sdk/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, FolderOpen, Link2, Network, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "@/api/client";
import { confirmDocumentClose, DocumentWorkspace } from "@/components/DocumentWorkspace";
import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { noteEdges, noteKey, noteLinks } from "@/lib/knowledge-graph";
import { useViewParam } from "@/lib/view-params";

const connectionLimit = 150;

export function KnowledgeNotebook({ projectId }: { projectId: string }) {
  const scope: WikiScope =
    projectId === "all" || projectId === "unassigned"
      ? { scope: "global" }
      : { project_id: projectId };
  const [params] = useSearchParams();
  const navigate = useNavigate();
  function setParams(update: (previous: URLSearchParams) => URLSearchParams): void {
    const next = update(new URLSearchParams(window.location.search));
    if (next.toString() === new URLSearchParams(window.location.search).toString()) return;
    navigate({ pathname: "/knowledge/wiki", search: next.toString(), hash: window.location.hash });
  }
  const slug = params.get("page");
  const pageScope: WikiScope = params.get("scope") === "global" ? { scope: "global" } : scope;
  const documentId = `wiki:${pageScope.project_id ?? "global"}:${slug}`;
  const [searchQuery, setSearchQuery] = useViewParam<string>("wikiQuery", "");
  const [filter, setFilter] = useState(searchQuery);
  useEffect(() => setFilter(searchQuery), [searchQuery]);
  const [filesView, setFilesView] = useViewParam<string>("wikiFiles", "closed", ["closed", "open"]);
  const [desktopFiles, setDesktopFiles] = useViewParam<string>("wikiTree", "open", [
    "open",
    "collapsed",
  ]);
  const [linksView, setLinksView] = useViewParam<string>("wikiLinks", "closed", ["closed", "open"]);
  const [graphView, setGraphView] = useViewParam<string>("wikiGraph", "closed", ["closed", "open"]);
  const filesOpen = filesView === "open";
  const filesCollapsed = desktopFiles === "collapsed";
  const linksOpen = linksView === "open";
  const graphOpen = graphView === "open";
  const setFilesOpen = (value: boolean) => setFilesView(value ? "open" : "closed");
  const setFilesCollapsed = (value: boolean) => setDesktopFiles(value ? "collapsed" : "open");
  const setLinksOpen = (value: boolean) => setLinksView(value ? "open" : "closed");
  const setGraphOpen = (value: boolean) => setGraphView(value ? "open" : "closed");
  const [creating, setCreating] = useState(false);
  const client = useQueryClient();
  const index = useQuery({
    queryKey: ["wiki", scope, "notebook"],
    queryFn: () => api.wiki.list(scope).then((response) => response.pages),
    refetchInterval: 30000,
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
  const search = useQuery({
    queryKey: ["wiki-search", scope, searchQuery],
    queryFn: () => api.wiki.search(searchQuery, scope).then((response) => response.results),
    enabled: Boolean(searchQuery.trim()),
  });
  const connections = useQuery({
    queryKey: [
      "wiki-connections",
      scope,
      index.data?.map((entry) => `${noteKey(entry)}:${entry.revision}`),
    ],
    enabled: (linksOpen || graphOpen) && Boolean(index.data),
    staleTime: 30000,
    queryFn: async ({ signal }) => {
      const entries = (index.data ?? []).slice(0, connectionLimit);
      const loaded: WikiPage[] = [];
      let cursor = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, entries.length) }, async () => {
          while (cursor < entries.length) {
            signal.throwIfAborted();
            const entry = entries[cursor++];
            const document = await api.wiki.get(
              entry.slug,
              entry.project_id === null ? { scope: "global" } : { project_id: entry.project_id },
            );
            signal.throwIfAborted();
            loaded.push(document);
          }
        }),
      );
      return loaded;
    },
  });
  function select(entry: WikiIndexEntry) {
    if (noteKey(entry) === `${pageScope.project_id ?? "global"}:${slug}`) {
      setFilesOpen(false);
      return;
    }
    if (!confirmDocumentClose(documentId)) return;
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.set("page", entry.slug);
      if (entry.project_id === null) next.set("scope", "global");
      else next.delete("scope");
      next.delete("wikiFiles");
      return next;
    });
  }
  const visible = searchQuery
    ? (search.data ?? [])
    : (index.data ?? []).filter((entry) =>
        `${entry.title} ${entry.slug} ${entry.tags.join(" ")}`
          .toLowerCase()
          .includes(filter.toLowerCase()),
      );
  const edges = noteEdges(connections.data ?? []);
  const currentKey = page.data ? noteKey(page.data) : "";
  const backlinks = (connections.data ?? []).filter((entry) =>
    edges.some((edge) => edge.from === noteKey(entry) && edge.to === currentKey),
  );
  const outgoing = page.data ? noteLinks(page.data.content) : [];
  const tree = (
    <aside aria-label="Note files" data-testid="notebook-files" className="min-w-0 space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-medium text-sm">Pages</h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close files"
          className="lg:hidden"
          onClick={() => setFilesOpen(false)}
        >
          <X size={16} />
        </Button>
      </div>
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          setSearchQuery(filter.trim());
        }}
      >
        <Input
          aria-label="Search Wiki pages"
          data-testid="wiki-search-input"
          placeholder="Search Wiki…"
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
            if (!event.target.value.trim()) setSearchQuery("");
          }}
        />
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" type="submit" data-testid="wiki-search-submit">
            Search
          </Button>
          {searchQuery && (
            <Button
              variant="ghost"
              type="button"
              onClick={() => {
                setFilter("");
                setSearchQuery("");
              }}
            >
              Clear
            </Button>
          )}
        </div>
      </form>
      {search.isFetching && (
        <p role="status" className="text-sm text-muted-foreground">
          Searching Wiki…
        </p>
      )}
      {search.error && (
        <p role="alert" className="text-sm text-error">
          {(search.error as Error).message}
        </p>
      )}
      {index.isLoading && (
        <p role="status" data-testid="page-loading" className="text-sm text-outline">
          Loading notes…
        </p>
      )}
      {index.error && (
        <p role="alert" data-testid="page-error" className="text-sm text-error">
          {(index.error as Error).message}
        </p>
      )}
      {!index.isLoading &&
        !index.error &&
        !search.isFetching &&
        !search.error &&
        !visible.length && (
          <p data-testid="page-empty" className="text-sm text-outline">
            {filter ? "No matching pages." : "No pages yet. Create your first Wiki page."}
          </p>
        )}
      {["lesson", "procedure", "decision", "concept"].map((kind) => {
        const notes = visible.filter((entry) => entry.kind === kind);
        if (!notes.length) return null;
        return (
          <details key={kind} open className="space-y-1">
            <summary className="cursor-pointer py-2 text-sm text-outline capitalize">
              {kind}s <span className="ml-1">{notes.length}</span>
            </summary>
            {notes.map((entry) => (
              <button
                key={noteKey(entry)}
                type="button"
                data-testid="notebook-note"
                data-slug={entry.slug}
                aria-current={currentKey === noteKey(entry) ? "page" : undefined}
                onClick={() => select(entry)}
                className={`flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${currentKey === noteKey(entry) ? "bg-primary/10 text-primary" : "text-on-surface hover:bg-surface-high"}`}
              >
                <FileText className="shrink-0" size={15} />
                <span data-testid="wiki-page-row" className="min-w-0">
                  <span className="block truncate">{entry.title}</span>
                  {searchQuery && (
                    <span className="block text-xs text-outline line-clamp-2">{entry.summary}</span>
                  )}
                </span>
                {entry.project_id === null && projectId !== "all" && (
                  <span className="ml-auto text-xs text-outline">Global</span>
                )}
              </button>
            ))}
          </details>
        );
      })}
    </aside>
  );
  return (
    <section
      data-testid="knowledge-notebook"
      className="min-w-0 rounded-lg border border-outline-variant bg-surface-low"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-outline-variant p-3">
        <Button
          variant="ghost"
          className="hidden lg:inline-flex"
          aria-expanded={!filesCollapsed}
          aria-controls="notebook-files-panel"
          data-testid="notebook-files-collapse"
          onClick={() => setFilesCollapsed(!filesCollapsed)}
        >
          <FolderOpen size={16} />
          Files
        </Button>
        <Button
          variant="outline"
          className="lg:hidden"
          aria-expanded={filesOpen}
          aria-controls="notebook-files-panel"
          data-testid="notebook-files-toggle"
          onClick={() => {
            setFilesOpen(!filesOpen);
            setLinksOpen(false);
          }}
        >
          <FolderOpen size={16} />
          Files
        </Button>
        <span className="mr-auto text-sm text-outline">
          {scope.scope === "global" ? "Global Wiki" : "Project Wiki"}
        </span>
        <Button
          variant={graphOpen ? "secondary" : "ghost"}
          aria-pressed={graphOpen}
          data-testid="notebook-graph-toggle"
          onClick={() => setGraphOpen(!graphOpen)}
        >
          <Network size={16} />
          Graph
        </Button>
        <Button
          variant={linksOpen ? "secondary" : "ghost"}
          aria-expanded={linksOpen}
          aria-controls="notebook-links"
          data-testid="notebook-links-toggle"
          onClick={() => {
            setLinksOpen(!linksOpen);
            setFilesOpen(false);
          }}
        >
          <Link2 size={16} />
          Links
        </Button>
        <Button data-testid="notebook-create" onClick={() => setCreating(true)}>
          <Plus size={16} />
          New page
        </Button>
      </div>
      <div className="flex min-w-0 flex-col lg:flex-row">
        <div
          id="notebook-files-panel"
          className={`${filesOpen ? "block" : "hidden"} ${filesCollapsed ? "lg:hidden" : "lg:block"} w-full shrink-0 border-b border-outline-variant lg:w-60 lg:border-b-0 lg:border-r`}
        >
          {tree}
        </div>
        <section aria-label="Note document" className="min-w-0 flex-1 p-4 sm:p-6">
          {graphOpen && (
            <div
              data-testid="notebook-graph"
              className="mb-6 rounded-lg border border-outline-variant bg-background p-4"
            >
              <h2 className="mb-2 font-medium">Connected notes</h2>
              {connections.isLoading && (
                <p role="status" className="text-sm text-outline">
                  Reading note connections…
                </p>
              )}
              {connections.error && (
                <p role="alert" className="text-sm text-error">
                  Could not load connections. {(connections.error as Error).message}
                </p>
              )}
              {connections.data && (
                <NoteGraph
                  pages={connections.data}
                  edges={edges}
                  currentKey={currentKey}
                  select={select}
                />
              )}
              {(index.data?.length ?? 0) > connectionLimit && (
                <p className="mt-3 text-xs text-outline">
                  Connections cover the first {connectionLimit} notes in this notebook.
                </p>
              )}
            </div>
          )}
          {!slug && (
            <div className="mx-auto flex min-h-72 max-w-lg flex-col justify-center py-12">
              <FileText size={28} className="mb-4 text-primary" />
              <h2 className="text-xl font-semibold">Your connected Wiki</h2>
              <p className="mt-3 text-base leading-relaxed text-outline">
                Keep decisions, lessons and procedures close to your project. Open a note from
                Files, or create one and connect it with{" "}
                <code className="text-primary">[[note-slug]]</code> links.
              </p>
              <Button className="mt-5 w-fit" onClick={() => setCreating(true)}>
                Create a Wiki page
              </Button>
            </div>
          )}
          {page.isLoading && (
            <p role="status" className="text-sm text-outline">
              Opening note…
            </p>
          )}
          {page.error && (
            <p role="alert" className="text-sm text-error">
              {(page.error as Error).message}
            </p>
          )}
          {page.data && (
            <article data-testid="notebook-document" className="min-w-0">
              <div className="mb-5">
                <p className="mb-2 text-sm text-outline capitalize">
                  {page.data.kind} / {page.data.project_id ? "Project" : "Global"}
                </p>
                <h1 className="break-words text-2xl font-semibold">{page.data.title}</h1>
                <p className="mt-2 text-sm leading-relaxed text-outline">{page.data.summary}</p>
              </div>
              <DocumentWorkspace
                key={documentId}
                documentId={documentId}
                path={`${page.data.slug}.md`}
                content={page.data.content}
                testId="wiki-editor-content"
                wikiLinks={{
                  slugs: (index.data ?? []).map((entry) => entry.slug),
                  select: (next) => {
                    const target = index.data?.find((entry) => entry.slug === next);
                    if (target) select(target);
                  },
                }}
                onSave={async (content, expectedContent) => {
                  const current = page.data;
                  if (!current || current.content !== expectedContent)
                    throw new Error(
                      "This note changed since it was opened. Reopen it before saving.",
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
                      content,
                      expected_revision: current.revision,
                      author: "human",
                      note: "Manual Markdown edit",
                    })
                    .catch(async (error: unknown) => {
                      // Keep the draft while refreshing the revision that Discard can adopt.
                      await page.refetch();
                      throw error;
                    });
                  await Promise.all(
                    ["wiki", "wiki-page", "wiki-history", "wiki-changes", "wiki-connections"].map(
                      (key) => client.invalidateQueries({ queryKey: [key] }),
                    ),
                  );
                  return saved.content;
                }}
              />
              <details className="mt-5 rounded-md border border-outline-variant p-3">
                <summary className="cursor-pointer text-sm">
                  Revision history · current {page.data.revision}
                </summary>
                {history.error && (
                  <p role="alert" className="mt-3 text-sm text-error">
                    {(history.error as Error).message}
                  </p>
                )}
                {history.data?.revisions.map((revision) => (
                  <details
                    key={revision.revision}
                    data-testid="wiki-revision"
                    className="mt-3 text-sm"
                  >
                    <summary className="cursor-pointer">
                      Revision {revision.revision} · {revision.note} · {revision.author}
                    </summary>
                    <Markdown>{revision.content}</Markdown>
                  </details>
                ))}
              </details>
            </article>
          )}
        </section>
        {linksOpen && (
          <aside
            id="notebook-links"
            data-testid="notebook-links"
            aria-label="Note connections"
            className="w-full shrink-0 space-y-5 border-t border-outline-variant p-4 lg:w-60 lg:border-l lg:border-t-0"
          >
            <h2 className="font-medium text-sm">Connections</h2>
            {connections.isLoading && (
              <p role="status" className="text-sm text-outline">
                Loading backlinks…
              </p>
            )}
            {connections.error && (
              <p role="alert" className="text-sm text-error">
                Connections could not be loaded.
              </p>
            )}
            {!page.data && (
              <p className="text-sm text-outline">Open a note to explore its connections.</p>
            )}
            {page.data && (
              <>
                <div>
                  <h3 className="mb-2 text-sm text-outline">Linked notes ({outgoing.length})</h3>
                  {outgoing.map((targetSlug) => {
                    const target =
                      index.data?.find(
                        (entry) =>
                          entry.slug === targetSlug && entry.project_id === page.data?.project_id,
                      ) ??
                      index.data?.find(
                        (entry) => entry.slug === targetSlug && entry.project_id === null,
                      ) ??
                      index.data?.find((entry) => entry.slug === targetSlug);
                    return target ? (
                      <button
                        type="button"
                        key={targetSlug}
                        className="block min-h-11 w-full break-words rounded-md p-2 text-left text-sm text-primary hover:bg-surface-high"
                        onClick={() => select(target)}
                      >
                        {target.title}
                      </button>
                    ) : (
                      <p key={targetSlug} className="py-2 text-sm text-outline">
                        {targetSlug} <span className="text-xs">(missing note)</span>
                      </p>
                    );
                  })}
                  {!outgoing.length && (
                    <p className="text-sm text-outline">Add [[note-slug]] to connect a note.</p>
                  )}
                </div>
                <div>
                  <h3 className="mb-2 text-sm text-outline">Backlinks ({backlinks.length})</h3>
                  {backlinks.map((entry) => (
                    <button
                      type="button"
                      key={noteKey(entry)}
                      className="block min-h-11 w-full break-words rounded-md p-2 text-left text-sm text-primary hover:bg-surface-high"
                      onClick={() => select(entry)}
                    >
                      {entry.title}
                    </button>
                  ))}
                  {connections.isSuccess && !backlinks.length && (
                    <p className="text-sm text-outline">No notes link here yet.</p>
                  )}
                </div>
                <div className="text-xs text-outline">
                  Revision {page.data.revision} · {page.data.author}
                </div>
                {page.data.sources.length > 0 && (
                  <div>
                    <h3 className="text-sm text-outline">Sources</h3>
                    {page.data.sources.map((source) => (
                      <p key={source} className="mt-2 break-all text-xs">
                        {source}
                      </p>
                    ))}
                  </div>
                )}
              </>
            )}
            {(index.data?.length ?? 0) > connectionLimit && (
              <p className="text-xs text-outline">
                Backlinks cover the first {connectionLimit} notes.
              </p>
            )}
          </aside>
        )}
      </div>
      {creating && (
        <CreateNote
          scope={scope}
          close={() => setCreating(false)}
          saved={(entry) => {
            setCreating(false);
            select(entry);
          }}
        />
      )}
    </section>
  );
}

function NoteGraph({
  pages,
  edges,
  currentKey,
  select,
}: {
  pages: WikiPage[];
  edges: ReturnType<typeof noteEdges>;
  currentKey: string;
  select: (entry: WikiIndexEntry) => void;
}) {
  const connected = pages
    .filter((page) =>
      edges.some((edge) => edge.from === noteKey(page) || edge.to === noteKey(page)),
    )
    .sort((a, b) => {
      if (noteKey(a) === currentKey) return -1;
      if (noteKey(b) === currentKey) return 1;
      return a.title.localeCompare(b.title);
    });
  const nodes = connected.slice(0, 40);
  const positions = new Map(
    nodes.map((page, index) => [
      noteKey(page),
      {
        x: 300 + Math.cos((index / nodes.length) * Math.PI * 2) * 220,
        y: 180 + Math.sin((index / nodes.length) * Math.PI * 2) * 135,
      },
    ]),
  );
  return (
    <>
      <section
        className="max-w-full overflow-x-auto"
        aria-label="Scrollable note graph"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need to scroll the graph canvas
        tabIndex={0}
      >
        <svg
          viewBox="0 0 600 360"
          className="h-[360px] w-[600px] min-w-[600px] max-w-none"
          role="img"
          aria-label={`Graph of ${nodes.length} notes. Use the connected notes list below to navigate.`}
        >
          <title>Linked notebook graph</title>
          {edges.map((edge) => {
            const from = positions.get(edge.from);
            const to = positions.get(edge.to);
            return from && to ? (
              <line
                key={`${edge.from}:${edge.to}`}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                className="stroke-outline-variant"
                strokeWidth="2"
              />
            ) : null;
          })}
          {nodes.map((node) => {
            const point = positions.get(noteKey(node));
            return point ? (
              <g key={noteKey(node)}>
                <circle
                  cx={point.x}
                  cy={point.y}
                  r={noteKey(node) === currentKey ? 7 : 5}
                  className="fill-primary"
                />
                {(nodes.length <= 8 || noteKey(node) === currentKey) && (
                  <text
                    x={point.x}
                    y={point.y - 12}
                    textAnchor="middle"
                    className="fill-on-surface text-[12px]"
                  >
                    {node.title.length > 20 ? `${node.title.slice(0, 19)}…` : node.title}
                  </text>
                )}
              </g>
            ) : null;
          })}
        </svg>
      </section>
      {!connected.length && (
        <p className="text-sm text-outline">No connections yet. Link notes using [[note-slug]].</p>
      )}
      {connected.length > 40 && (
        <p className="text-xs text-outline">
          Graph shows 40 connected notes. All loaded connections are listed below.
        </p>
      )}
      <nav className="mt-3 flex flex-wrap gap-2" aria-label="Connected notes navigation">
        {connected.map((entry) => (
          <Button
            key={noteKey(entry)}
            variant={noteKey(entry) === currentKey ? "secondary" : "outline"}
            onClick={() => select(entry)}
            className="max-w-full whitespace-normal text-left"
          >
            {entry.title}
          </Button>
        ))}
      </nav>
    </>
  );
}

function CreateNote({
  scope,
  close,
  saved,
}: {
  scope: WikiScope;
  close: () => void;
  saved: (page: WikiPage) => void;
}) {
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [summary, setSummary] = useState("");
  const [kind, setKind] = useState<WikiPage["kind"]>("concept");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const client = useQueryClient();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) close();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Wiki page</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (pending) return;
            setPending(true);
            setError("");
            try {
              const page = await api.wiki.write({
                project_id: scope.project_id ?? null,
                slug,
                title: title.trim(),
                summary: summary.trim(),
                kind,
                content: `# ${title.trim()}\n\n${summary.trim()}`,
                tags: [],
                sources: [],
                expected_revision: 0,
                author: "human",
                note: "Created a note",
              });
              await client.invalidateQueries({ queryKey: ["wiki"] });
              saved(page);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "Could not create note");
            } finally {
              setPending(false);
            }
          }}
        >
          <p className="text-sm text-outline">
            {scope.project_id
              ? "Saved to the current project notebook."
              : "Saved to the global notebook."}
          </p>
          <div className="space-y-2">
            <Label htmlFor="note-title">Title</Label>
            <Input
              id="note-title"
              data-testid="note-title"
              required
              maxLength={200}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="note-slug">Link name</Label>
            <Input
              id="note-slug"
              data-testid="note-slug"
              required
              maxLength={100}
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              placeholder="project-decisions"
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
            />
            <p className="text-xs text-outline">
              Lowercase words separated by hyphens. Link with [[{slug || "project-decisions"}]].
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="note-summary">Summary</Label>
            <Input
              id="note-summary"
              required
              maxLength={300}
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="note-kind">Type</Label>
            <select
              id="note-kind"
              className="min-h-11 w-full rounded-md border border-outline-variant bg-background px-3 text-sm text-on-surface"
              value={kind}
              onChange={(event) => setKind(event.target.value as WikiPage["kind"])}
            >
              {["concept", "lesson", "procedure", "decision"].map((value) => (
                <option key={value} value={value}>
                  {value[0].toUpperCase() + value.slice(1)}
                </option>
              ))}
            </select>
          </div>
          {error && (
            <p role="alert" className="text-sm text-error">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={pending} onClick={close}>
              Cancel
            </Button>
            <Button type="submit" data-testid="note-create-submit" disabled={pending}>
              {pending ? "Creating…" : "Create page"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
