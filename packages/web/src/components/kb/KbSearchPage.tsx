import type { KbDocumentListing, KbScope, KbSearchMode, KnowledgeBase } from "@orc/core/kb";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { Fragment } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { useKbSearch } from "@/hooks/useKnowledge";
import { cn } from "@/lib/utils";

function plainText(markdown: string): string {
  return markdown
    .replace(/```[\w-]*/g, " ")
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/(^|\n)\s*(?:>\s*)+/g, "$1")
    .replace(/(^|\n)\s*(?:[-*+]|\d+[.)])\s+/g, "$1")
    .replace(/(^|\s)(?:\*{3,}|_{3,})(?=\s|$)/g, "$1")
    .replace(/`/g, "")
    .replace(/(^|[\s(«])[*_~]+(?=\S)/g, "$1")
    .replace(/(\S)[*_~]+(?=$|[\s).,;:!?»])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function Snippet({ text }: { text: string }) {
  const parts = plainText(text).split(/«([^»]*)»/g);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional
          <mark key={i} className="rounded-xs bg-primary/20 px-0.5 text-on-surface">
            {part}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

const MODE_LABEL: Record<KbSearchMode, string> = {
  auto: "Auto",
  lexical: "Keyword",
  semantic: "Semantic",
  hybrid: "Hybrid",
};

const MATCH_LABEL: Record<string, string> = {
  exact: "title",
  lexical: "keyword",
  semantic: "semantic",
};

function lastHeading(path: string[] | undefined): string | undefined {
  return path?.[path.length - 1];
}

export function KbSearchPage({
  query,
  queryInput,
  onQueryInput,
  onQuery,
  mode,
  onMode,
  scope,
  onScope,
  labels,
  onLabels,
  kbId,
  kbName,
  onKb,
  bases,
  listing,
  mediaType,
  onMediaType,
  search,
  onOpen,
  onClear,
}: {
  query: string;
  queryInput: string;
  onQueryInput: (value: string) => void;
  onQuery: (value: string) => void;
  mode: KbSearchMode;
  onMode: (mode: KbSearchMode) => void;
  scope: KbScope;
  onScope: (scope: KbScope) => void;
  labels: string[];
  onLabels: (labels: string[]) => void;
  kbId: string | null;
  kbName: string;
  onKb: (id: string | null) => void;
  bases: KnowledgeBase[];
  listing: KbDocumentListing | undefined;
  mediaType: string;
  onMediaType: (type: string) => void;
  search: ReturnType<typeof useKbSearch>;
  onOpen: (documentId: string, heading?: string) => void;
  onClear: () => void;
}) {
  const result = search.data;
  const mediaTypes = [...new Set((listing?.documents ?? []).map((doc) => doc.media_type))].sort();
  return (
    <section
      data-testid={query ? "kb-search-results" : "kb-search-page"}
      aria-label="Search knowledge"
      className="w-full min-w-0 space-y-5 p-4 sm:p-6"
    >
      <header className="space-y-1">
        <p className="text-xs text-outline">Search</p>
        <h1 className="text-2xl font-medium tracking-tight">
          {query ? `Results for “${query}”` : `Search ${kbName}`}
        </h1>
        <p className="text-sm text-outline">
          Search merges exact title and keyword matches, plus semantic matches when embeddings are
          ready. Labels narrow every path.
        </p>
      </header>

      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          onQuery(queryInput.trim());
        }}
      >
        <div className="relative min-w-0 flex-1 basis-72">
          <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-outline" />
          <Input
            aria-label="Search query"
            data-testid="kb-search-page-input"
            value={queryInput}
            onChange={(event) => onQueryInput(event.target.value)}
            placeholder="Search words, a title or a phrase"
            className="h-10 pl-8"
            autoFocus={!query}
          />
        </div>
        <Button type="submit" size="sm" data-testid="kb-search-page-submit">
          Search
        </Button>
        {query && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onClear}
            data-testid="kb-search-clear"
          >
            <X size={14} /> Clear
          </Button>
        )}
      </form>

      <div className="flex flex-wrap items-center gap-2" data-testid="kb-search-facets">
        <fieldset
          className="flex items-center gap-0.5 rounded-md border border-outline-variant p-0.5"
          aria-label="Search mode"
        >
          {(Object.keys(MODE_LABEL) as KbSearchMode[])
            .filter((item) => item !== "hybrid")
            .map((item) => (
              <button
                key={item}
                type="button"
                data-testid={`kb-search-mode-${item}`}
                aria-pressed={mode === item}
                className={cn(
                  "min-h-7 rounded px-2 text-xs",
                  mode === item
                    ? "bg-surface-highest text-on-surface"
                    : "text-outline hover:text-on-surface",
                )}
                onClick={() => onMode(item)}
              >
                {MODE_LABEL[item]}
              </button>
            ))}
        </fieldset>
        <Select value={scope} onValueChange={(value) => onScope(value as KbScope)}>
          <SelectTrigger
            className="h-8 w-40"
            aria-label="Search scope"
            data-testid="kb-search-scope"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">This workspace</SelectItem>
            <SelectItem value="project">Project only</SelectItem>
            <SelectItem value="global">Global only</SelectItem>
            <SelectItem value="all">Every knowledge base</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={kbId ?? "all"}
          onValueChange={(value) => onKb(value === "all" ? null : value)}
        >
          <SelectTrigger
            className="h-8 w-44"
            aria-label="Knowledge base"
            data-testid="kb-search-kb"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All visible bases</SelectItem>
            {bases.map((base) => (
              <SelectItem key={base.id} value={base.id}>
                {base.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={mediaType || "any"}
          onValueChange={(value) => onMediaType(value === "any" ? "" : value)}
        >
          <SelectTrigger className="h-8 w-36" aria-label="Media type" data-testid="kb-search-media">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any type</SelectItem>
            {mediaTypes.map((type) => (
              <SelectItem key={type} value={type}>
                {type.replace("text/", "").replace("application/", "")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {(listing?.labels.length ?? 0) > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 inline-flex items-center gap-1 text-xs text-outline">
            <SlidersHorizontal size={12} /> Labels
          </span>
          {[...(listing?.labels ?? [])]
            .sort((a, b) => b.count - a.count)
            .slice(0, 20)
            .map((item) => {
              const active = labels.includes(item.label);
              return (
                <button
                  key={item.label}
                  type="button"
                  data-testid="kb-search-label"
                  aria-pressed={active}
                  className={cn(
                    "min-h-7 rounded-full border px-2 text-xs",
                    active
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-outline-variant text-outline hover:text-on-surface",
                  )}
                  onClick={() =>
                    onLabels(
                      active
                        ? labels.filter((label) => label !== item.label)
                        : [...labels, item.label],
                    )
                  }
                >
                  {item.label} <span className="tabular-nums">{item.count}</span>
                </button>
              );
            })}
          {labels.length > 1 && (
            <span className="text-[11px] text-outline">all selected labels must match</span>
          )}
        </div>
      )}

      {result?.degraded && (
        <p role="status" className="text-sm text-warning">
          {result.degraded}
        </p>
      )}
      {search.isLoading && <p className="text-sm text-outline">Searching…</p>}
      {search.error && (
        <p role="alert" className="text-sm text-error">
          {(search.error as Error).message}
        </p>
      )}
      {query && result && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-outline">
          <span data-testid="kb-search-count">
            {result.hits.length} {result.hits.length === 1 ? "document" : "documents"}
          </span>
          <span aria-hidden>·</span>
          <span>mode {MODE_LABEL[result.mode]}</span>
          <span aria-hidden>·</span>
          <span>
            {Math.round(
              Object.values(result.timings_ms).reduce((total, value) => total + value, 0),
            )}{" "}
            ms
          </span>
        </div>
      )}
      {query && result?.hits.length === 0 && (
        <p className="text-sm text-outline" data-testid="kb-search-empty">
          Nothing matched. Try fewer words, another scope, or no labels.
        </p>
      )}
      <div className="space-y-5">
        {result?.hits.map((hit) => (
          <article
            key={hit.document_id}
            data-testid="kb-search-result"
            className="space-y-2 border-b border-outline-variant pb-4"
          >
            <button
              type="button"
              className="block w-full text-left"
              onClick={() => onOpen(hit.document_id, lastHeading(hit.passages[0]?.heading_path))}
            >
              <span className="block font-medium text-primary hover:underline">{hit.title}</span>
              <span className="block break-all text-xs text-outline">
                {hit.kb_name} · {hit.path} · revision {hit.revision}
              </span>
            </button>
            <div className="flex flex-wrap items-center gap-1.5">
              {hit.matched_by.map((match) => (
                <span
                  key={match}
                  data-testid="kb-search-matched"
                  className="rounded-full bg-surface-high px-2 text-[10px] text-outline"
                >
                  {MATCH_LABEL[match] ?? match}
                </span>
              ))}
              {hit.labels.map((label) => (
                <span
                  key={label}
                  className="rounded-full border border-outline-variant px-2 text-[10px] text-outline"
                >
                  {label}
                </span>
              ))}
            </div>
            {hit.passages.map((passage) => (
              // biome-ignore lint/a11y/useKeyWithClickEvents: the title button is the keyboard path
              // biome-ignore lint/a11y/noStaticElementInteractions: passage is a secondary click target
              <div
                key={passage.chunk_id}
                data-testid="kb-search-passage"
                className="cursor-pointer space-y-1 rounded-md p-2 hover:bg-surface-high"
                onClick={() => onOpen(hit.document_id, lastHeading(passage.heading_path))}
              >
                {(passage.heading_path.length > 0 ||
                  passage.locator?.page ||
                  passage.locator?.sheet) && (
                  <div className="text-xs text-outline">
                    {[
                      ...passage.heading_path.map(plainText),
                      ...(passage.locator?.page ? [`page ${passage.locator.page}`] : []),
                      ...(passage.locator?.sheet ? [`sheet ${passage.locator.sheet}`] : []),
                    ].join(" › ")}
                  </div>
                )}
                <p className="max-w-[68ch] text-sm leading-relaxed">
                  <Snippet text={passage.snippet} />
                </p>
              </div>
            ))}
          </article>
        ))}
      </div>
    </section>
  );
}
