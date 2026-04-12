import { useState } from "react";
import { Search, RefreshCw } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { ViewHeader } from "@/components/ViewHeader";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";

export default function Knowledge() {
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const qc = useQueryClient();

  const { data: collectionsData, isLoading, error } = useQuery({
    queryKey: ["knowledge-collections"],
    queryFn: () => api.knowledge.collections(),
    refetchInterval: 60_000,
  });

  const { data: searchData, isLoading: isSearching } = useQuery({
    queryKey: ["knowledge-search", query],
    queryFn: () => api.knowledge.search(query, { limit: 20 }),
    enabled: query.trim().length > 0,
  });

  const reindex = useMutation({
    mutationFn: () => api.knowledge.update(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["knowledge-collections"] }),
  });

  if (error) return <ErrorState message={(error as Error).message} />;

  const collections = collectionsData?.collections ?? [];
  const totalDocs = collections.reduce((sum, c) => sum + c.documentCount, 0);

  return (
    <div>
      <ViewHeader
        title="Knowledge"
        meta={`${totalDocs} documents`}
        action={
          <Button size="sm" variant="ghost" onClick={() => reindex.mutate()}
            disabled={reindex.isPending}
            className="font-label text-[10px] uppercase tracking-widest text-outline">
            <RefreshCw size={12} className={`mr-1 ${reindex.isPending ? "animate-spin" : ""}`} />
            {reindex.isPending ? "Indexing..." : "Reindex"}
          </Button>
        }
      />

      {/* Search */}
      <div className="flex gap-2 mb-6">
        <div className="relative flex-1">
          <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-outline" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setQuery(searchInput)}
            placeholder="Search knowledge base..."
            className="pl-8 bg-surface-highest border-surface-highest text-on-surface font-body text-xs"
          />
        </div>
        <Button size="sm" onClick={() => setQuery(searchInput)}
          className="font-label text-xs uppercase bg-primary/10 text-primary border border-primary/30">
          Search
        </Button>
        {query && (
          <Button size="sm" variant="ghost" onClick={() => { setQuery(""); setSearchInput(""); }}
            className="font-label text-xs text-outline">Clear</Button>
        )}
      </div>

      {/* Search results */}
      {query && (
        <div className="mb-6">
          <div className="font-label text-[9px] uppercase tracking-widest text-outline mb-3">
            Search Results
          </div>
          {isSearching ? (
            <Skeleton className="h-20 w-full bg-surface-highest" />
          ) : (searchData?.results ?? []).length === 0 ? (
            <EmptyState message="No results" />
          ) : (
            <div className="border border-surface-highest rounded-sm overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="border-b border-surface-highest hover:bg-transparent">
                    <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">Title</TableHead>
                    <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-28">Collection</TableHead>
                    <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">Snippet</TableHead>
                    <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-16">Score</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(searchData?.results ?? []).map((r) => (
                    <TableRow key={r.docid} className="border-b border-surface-highest/50 hover:bg-surface-low">
                      <TableCell className="font-body text-xs font-medium text-on-surface">{r.title || r.path}</TableCell>
                      <TableCell className="font-label text-[10px] text-primary">{r.collection}</TableCell>
                      <TableCell className="font-body text-[10px] text-outline max-w-sm truncate">{r.snippet}</TableCell>
                      <TableCell className="font-label text-[10px] text-outline">{r.score.toFixed(2)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}

      {/* Collections */}
      <div>
        <div className="font-label text-[9px] uppercase tracking-widest text-outline mb-3">Collections</div>
        {isLoading ? (
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-10 w-full bg-surface-highest" />)}
          </div>
        ) : collections.length === 0 ? (
          <EmptyState message="No collections" />
        ) : (
          <div className="border border-surface-highest rounded-sm overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="border-b border-surface-highest hover:bg-transparent">
                  <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">Name</TableHead>
                  <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">Path</TableHead>
                  <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">Docs</TableHead>
                  <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-36">Last Modified</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {collections.map((c) => (
                  <TableRow key={c.name} className="border-b border-surface-highest/50 hover:bg-surface-low">
                    <TableCell className="font-label text-xs font-semibold text-primary">{c.name}</TableCell>
                    <TableCell className="font-body text-[10px] text-outline truncate max-w-xs">{c.path}</TableCell>
                    <TableCell className="font-label text-xs text-on-surface">{c.documentCount}</TableCell>
                    <TableCell className="font-label text-[10px] text-outline">
                      {c.lastModified ? new Date(c.lastModified).toLocaleDateString() : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
