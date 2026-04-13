import { Plus, Search } from "lucide-react";
import { useState } from "react";
import type { SkillFull, SkillSource } from "@/api/client";
import { DetailField } from "@/components/DetailField";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ViewHeader } from "@/components/ViewHeader";
import { useCreateSkill, useSkill, useSkills } from "@/hooks/useSkills";

type SourceFilter = "all" | "builtin" | "user";

const SOURCE_FILTERS: Array<{ value: SourceFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "builtin", label: "Built-in" },
  { value: "user", label: "User" },
];

const SOURCE_COLORS: Record<SkillSource, string> = {
  builtin: "bg-primary/15 text-primary border-primary/30",
  user: "bg-tertiary/15 text-tertiary border-tertiary/30",
};

export default function Skills() {
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const {
    data: skills,
    isLoading,
    error,
    refetch,
  } = useSkills({
    q: query || undefined,
    source: sourceFilter === "all" ? undefined : sourceFilter,
  });

  if (error) return <ErrorState message={(error as Error).message} onRetry={() => refetch()} />;

  return (
    <div>
      <ViewHeader
        title="Skills"
        meta={`${(skills ?? []).length} skills`}
        action={
          <Button
            size="sm"
            onClick={() => setCreating(true)}
            className="font-label text-xs uppercase tracking-widest bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20"
          >
            <Plus size={12} className="mr-1" /> New Skill
          </Button>
        }
      />

      {/* Source filter pills */}
      <div className="flex items-center gap-4 mb-4">
        <div className="flex gap-1.5">
          {SOURCE_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setSourceFilter(f.value)}
              className={`font-label text-[10px] uppercase tracking-widest px-3 py-1.5 border transition-colors ${
                sourceFilter === f.value
                  ? "bg-primary/15 text-primary border-primary/30"
                  : "bg-surface-highest border-surface-highest text-outline hover:text-on-surface-variant"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="relative flex-1">
          <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-outline" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setQuery(searchInput)}
            placeholder="Search skills..."
            className="pl-8 bg-surface-highest border-surface-highest text-on-surface font-body text-xs placeholder:text-outline"
          />
        </div>
        <Button
          size="sm"
          onClick={() => setQuery(searchInput)}
          className="font-label text-xs uppercase bg-primary/10 text-primary border border-primary/30"
        >
          Search
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <Skeleton key={i} className="h-10 w-full bg-surface-highest" />
          ))}
        </div>
      ) : (skills ?? []).length === 0 ? (
        <EmptyState message={query ? "No skills match your search" : "No skills found"} />
      ) : (
        <div className="border border-surface-highest rounded-sm overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-surface-highest hover:bg-transparent">
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">
                  Name
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline">
                  Description
                </TableHead>
                <TableHead className="font-label text-[10px] uppercase tracking-widest text-outline w-24">
                  Source
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(skills ?? []).map((skill) => (
                <TableRow
                  key={skill.name}
                  className="border-b border-surface-highest/50 hover:bg-surface-low cursor-pointer"
                  onClick={() => setSelectedSkill(skill.name)}
                >
                  <TableCell className="font-body text-xs font-medium text-on-surface">
                    {skill.name}
                  </TableCell>
                  <TableCell className="font-body text-xs text-outline max-w-md truncate">
                    {skill.description || "\u2014"}
                  </TableCell>
                  <TableCell>
                    <span
                      className={`inline-flex px-2 py-0.5 font-label text-[10px] uppercase tracking-wider border ${SOURCE_COLORS[skill.source]}`}
                    >
                      {skill.source}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <SkillDetailSheet
        skillName={selectedSkill}
        open={Boolean(selectedSkill)}
        onClose={() => setSelectedSkill(null)}
      />

      {creating && <CreateSkillDialog open={creating} onClose={() => setCreating(false)} />}
    </div>
  );
}

function SkillDetailSheet({
  skillName,
  open,
  onClose,
}: {
  skillName: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const { data, isLoading } = useSkill(skillName);
  const skill = data as SkillFull | undefined;

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{skill?.name ?? "Skill Details"}</SheetTitle>
          {skill?.description && (
            <p className="font-body text-xs text-outline mt-1">{skill.description}</p>
          )}
        </SheetHeader>
        <SheetBody>
          {isLoading || !skill ? (
            <div className="space-y-3">
              {[...Array(4)].map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
                <Skeleton key={i} className="h-8 w-full bg-surface-highest" />
              ))}
            </div>
          ) : (
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <DetailField label="Source">
                  <span
                    className={`inline-flex px-2 py-0.5 font-label text-[10px] uppercase tracking-wider border ${SOURCE_COLORS[skill.source]}`}
                  >
                    {skill.source}
                  </span>
                </DetailField>
                <DetailField label="Path">
                  <code className="font-mono text-[10px] text-outline break-all">{skill.path}</code>
                </DetailField>
              </div>

              <div>
                <div className="font-label text-[10px] uppercase tracking-widest text-outline mb-2">
                  Content
                </div>
                <div className="border border-surface-highest rounded-sm overflow-hidden">
                  <ScrollArea className="h-[400px]">
                    <pre className="font-mono text-[11px] leading-relaxed bg-background p-4 whitespace-pre-wrap break-words text-on-surface">
                      {skill.content}
                    </pre>
                  </ScrollArea>
                </div>
              </div>

              {skill.references?.length > 0 && (
                <div>
                  <div className="font-label text-[10px] uppercase tracking-widest text-outline mb-2">
                    References
                  </div>
                  <div className="space-y-1">
                    {skill.references.map((ref) => (
                      <div
                        key={ref.name}
                        className="flex items-center gap-3 px-3 py-2 border border-surface-highest rounded-sm"
                      >
                        <span className="font-body text-xs font-medium text-on-surface">
                          {ref.name}
                        </span>
                        <code className="font-mono text-[10px] text-outline truncate">
                          {ref.path}
                        </code>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

function CreateSkillDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const createSkill = useCreateSkill();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !content.trim()) return;
    createSkill.mutate({ name: name.trim(), content: content.trim() }, { onSuccess: onClose });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="bg-surface border-surface-highest max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-headline text-sm uppercase tracking-widest text-on-surface">
            New Skill
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3 mt-2">
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
              Name *
            </Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-skill"
              className="bg-background border-surface-highest text-on-surface font-body text-xs"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-[10px] uppercase tracking-widest text-outline">
              Content *
            </Label>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="# Skill content (Markdown)..."
              className="bg-background border-surface-highest text-on-surface font-mono text-xs resize-none"
              rows={16}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="font-label text-xs uppercase text-outline"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={createSkill.isPending || !name.trim() || !content.trim()}
              className="font-label text-xs uppercase bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25"
            >
              {createSkill.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
