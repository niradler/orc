import { Plus, Search } from "lucide-react";
import { useState } from "react";
import type { SkillFull, SkillRefContent, SkillSource } from "@/api/client";
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
import { useDetailRoute } from "@/hooks/useDetailRoute";
import { useCreateSkill, useSkill, useSkills } from "@/hooks/useSkills";
import { readPrimitiveFolder } from "@/lib/primitive-files";

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
  const {
    selectedId: selectedSkill,
    openDetail: openSkillDetail,
    closeDetail: closeSkillDetail,
  } = useDetailRoute("/skills", "skillName");
  const [creating, setCreating] = useState(false);

  const {
    data: library,
    isLoading,
    error,
    refetch,
  } = useSkills({
    q: query || undefined,
    source: sourceFilter === "all" ? undefined : sourceFilter,
  });
  const skills = library?.skills;

  if (error) return <ErrorState message={(error as Error).message} onRetry={() => refetch()} />;

  return (
    <div>
      <ViewHeader
        title="Skills"
        meta={`${(skills ?? []).length} skills`}
        action={
          <Button
            data-testid="new-skill-button"
            size="sm"
            onClick={() => setCreating(true)}
            className="font-label text-xs uppercase tracking-widest bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20"
          >
            <Plus size={12} className="mr-1" /> New Skill
          </Button>
        }
      />

      <p className="text-xs text-outline mb-3">
        Skill folders follow the{" "}
        <a
          className="text-primary underline"
          href="https://agentskills.io/specification"
          target="_blank"
          rel="noreferrer"
        >
          Agent Skills specification
        </a>
        .
      </p>
      {library?.broken?.map((issue) => (
        <p key={issue.path} role="alert" className="text-destructive text-xs mb-2">
          {issue.path}: {issue.error}
        </p>
      ))}

      {/* Source filter pills */}
      <div className="flex items-center gap-4 mb-4">
        <div className="flex gap-1.5">
          {SOURCE_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setSourceFilter(f.value)}
              className={`font-label text-[11px] uppercase tracking-widest px-3 py-1.5 border transition-colors ${
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
                <TableHead className="font-label text-[11px] uppercase tracking-widest text-outline">
                  Name
                </TableHead>
                <TableHead className="font-label text-[11px] uppercase tracking-widest text-outline">
                  Description
                </TableHead>
                <TableHead className="font-label text-[11px] uppercase tracking-widest text-outline w-24">
                  Source
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(skills ?? []).map((skill) => (
                <TableRow
                  key={skill.name}
                  data-testid="skill-row"
                  data-skill-name={skill.name}
                  className="border-b border-surface-highest/50 hover:bg-surface-low cursor-pointer"
                  onClick={() => openSkillDetail(skill.name)}
                >
                  <TableCell className="font-body text-xs font-medium text-on-surface">
                    {skill.name}
                  </TableCell>
                  <TableCell className="font-body text-xs text-outline max-w-md truncate">
                    {skill.description || "\u2014"}
                  </TableCell>
                  <TableCell>
                    <span
                      className={`inline-flex px-2 py-0.5 font-label text-[11px] uppercase tracking-wider border ${SOURCE_COLORS[skill.source]}`}
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
        key={selectedSkill}
        skillName={selectedSkill}
        open={Boolean(selectedSkill)}
        onClose={closeSkillDetail}
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
  const { data, isLoading, error, refetch } = useSkill(skillName);
  const skill = data as SkillFull | undefined;
  const [selectedFile, setSelectedFile] = useState<string | undefined>();
  const fileQuery = useSkill(selectedFile ? skillName : null, selectedFile);
  const file = fileQuery.data as SkillRefContent | undefined;

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
          {error ? (
            <ErrorState message={(error as Error).message} onRetry={() => void refetch()} />
          ) : isLoading || !skill ? (
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
                    className={`inline-flex px-2 py-0.5 font-label text-[11px] uppercase tracking-wider border ${SOURCE_COLORS[skill.source]}`}
                  >
                    {skill.source}
                  </span>
                </DetailField>
                <DetailField label="Path">
                  <code className="font-mono text-[11px] text-outline break-all">{skill.path}</code>
                </DetailField>
              </div>

              <div>
                <div className="font-label text-[11px] uppercase tracking-widest text-outline mb-2">
                  {selectedFile ?? "SKILL.md"}
                </div>
                {selectedFile && (
                  <Button
                    data-testid="skill-show-entry"
                    variant="ghost"
                    onClick={() => setSelectedFile(undefined)}
                  >
                    Show SKILL.md
                  </Button>
                )}
                <div className="border border-surface-highest rounded-sm overflow-hidden">
                  <ScrollArea className="h-[400px]">
                    <pre
                      data-testid="skill-file-content"
                      className="font-mono text-[11px] leading-relaxed bg-background p-4 whitespace-pre-wrap break-words text-on-surface"
                    >
                      {selectedFile
                        ? fileQuery.error
                          ? (fileQuery.error as Error).message
                          : fileQuery.isLoading
                            ? "Loading..."
                            : file?.content
                        : skill.content}
                    </pre>
                    {file?.encoding === "base64" && (
                      <p className="p-4 text-xs text-outline">Binary asset shown as base64.</p>
                    )}
                  </ScrollArea>
                </div>
              </div>

              {skill.files?.length > 0 && (
                <div>
                  <div className="font-label text-[11px] uppercase tracking-widest text-outline mb-2">
                    Supporting files
                  </div>
                  <div className="space-y-1">
                    {skill.files.map((ref) => (
                      <button
                        type="button"
                        data-testid="skill-file"
                        data-file-name={ref.name}
                        onClick={() => setSelectedFile(ref.name)}
                        aria-pressed={selectedFile === ref.name}
                        key={ref.name}
                        className="flex w-full items-center gap-3 px-3 py-2 border border-surface-highest rounded-sm text-left hover:bg-surface-low"
                      >
                        <span className="font-body text-xs font-medium text-on-surface">
                          {ref.name}
                        </span>
                        <code className="font-mono text-[11px] text-outline truncate">
                          {ref.path}
                        </code>
                      </button>
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
  const [files, setFiles] = useState<
    Array<{ id: string; path: string; content: string; encoding: "utf8" | "base64" }>
  >([]);
  const [importError, setImportError] = useState<string>();
  const [importing, setImporting] = useState(false);

  async function importFolder(uploaded: FileList | null): Promise<void> {
    if (!uploaded?.length) return;
    setImporting(true);
    setImportError(undefined);
    try {
      const imported = (await readPrimitiveFolder(uploaded)).map((file) => ({
        ...file,
        encoding: file.encoding ?? "utf8",
        id: crypto.randomUUID(),
      }));
      const entry = imported.find((file) => file.path === "SKILL.md");
      if (!entry) throw new Error("Choose a skill folder containing SKILL.md");
      if (entry.encoding !== "utf8") throw new Error("SKILL.md must be UTF-8 text");
      setContent(entry.content);
      setName(uploaded[0].webkitRelativePath.split("/")[0]);
      setFiles(imported.filter((file) => file !== entry));
    } catch (error) {
      setImportError((error as Error).message);
    } finally {
      setImporting(false);
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !content.trim()) return;
    createSkill.mutate(
      {
        name: name.trim(),
        content: content.trim(),
        files: files.map(({ path, content, encoding }) => ({ path, content, encoding })),
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="bg-surface border-surface-highest max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-headline text-sm uppercase tracking-widest text-on-surface">
            New Skill
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3 mt-2 max-h-[75vh] overflow-y-auto">
          <Label htmlFor="skill-folder-input">Import skill folder</Label>
          <Input
            id="skill-folder-input"
            data-testid="skill-folder-input"
            type="file"
            multiple
            {...{ webkitdirectory: "" }}
            onChange={(event) => void importFolder(event.target.files)}
          />
          <div className="space-y-1.5">
            <Label className="font-label text-[11px] uppercase tracking-widest text-outline">
              Name *
            </Label>
            <Input
              data-testid="skill-name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-skill"
              className="bg-background border-surface-highest text-on-surface font-body text-xs"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-[11px] uppercase tracking-widest text-outline">
              SKILL.md *
            </Label>
            <Textarea
              data-testid="skill-content-input"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={
                "---\nname: my-skill\ndescription: When to use this skill\n---\n\n# Instructions"
              }
              className="bg-background border-surface-highest text-on-surface font-mono text-xs resize-none"
              rows={16}
            />
          </div>
          <div className="space-y-3">
            <Button
              data-testid="skill-add-file"
              type="button"
              variant="outline"
              onClick={() =>
                setFiles([
                  ...files,
                  { id: crypto.randomUUID(), path: "", content: "", encoding: "utf8" },
                ])
              }
            >
              Add supporting file
            </Button>
            {files.map((file) => (
              <div
                key={file.id}
                data-testid="skill-supporting-file"
                className="space-y-2 border border-surface-highest p-3"
              >
                <Input
                  data-testid="skill-file-path-input"
                  aria-label="File path"
                  placeholder="references/guide.md or scripts/check.py"
                  value={file.path}
                  onChange={(event) =>
                    setFiles(
                      files.map((item) =>
                        item.id === file.id ? { ...item, path: event.target.value } : item,
                      ),
                    )
                  }
                />
                <Textarea
                  data-testid="skill-file-content-input"
                  aria-label={`Content of ${file.path || "supporting file"}`}
                  value={file.content}
                  rows={4}
                  onChange={(event) =>
                    setFiles(
                      files.map((item) =>
                        item.id === file.id ? { ...item, content: event.target.value } : item,
                      ),
                    )
                  }
                />
                {file.encoding === "base64" && (
                  <p className="text-xs text-outline">Binary asset (base64)</p>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setFiles(files.filter((item) => item.id !== file.id))}
                >
                  Remove file
                </Button>
              </div>
            ))}
          </div>
          {(importError || createSkill.error) && (
            <p role="alert" className="text-sm text-destructive">
              {importError ?? createSkill.error?.message}
            </p>
          )}
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
              data-testid="skill-submit"
              type="submit"
              size="sm"
              disabled={
                importing ||
                createSkill.isPending ||
                !name.trim() ||
                !content.trim() ||
                files.some((file) => !file.path.trim())
              }
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
