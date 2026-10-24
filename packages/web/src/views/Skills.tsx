import type { ScopeQuery } from "@orc/sdk/types";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Download,
  Plus,
  Search,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, type SkillFull, type SkillRefContent, type SkillSource } from "@/api/client";
import { BulkActionBar } from "@/components/BulkActionBar";
import { CodeEditor } from "@/components/CodeEditor";
import { DetailField } from "@/components/DetailField";
import { DocumentTabs } from "@/components/DocumentTabs";
import { confirmDocumentClose, DocumentWorkspace } from "@/components/DocumentWorkspace";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { ImportLocalSkillsDialog } from "@/components/ImportLocalSkillsDialog";
import { ImportSkillDialog } from "@/components/ImportSkillDialog";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { SkillHistoryPanel } from "@/components/SkillHistoryPanel";
import { SkillSync } from "@/components/SkillSync";
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
import { ViewHeader } from "@/components/ViewHeader";
import { useDetailRoute } from "@/hooks/useDetailRoute";
import { useListSelection } from "@/hooks/useListSelection";
import { useProjectScope } from "@/hooks/useProjectScope";
import {
  useCreateSkill,
  useSetSkillVisibility,
  useSkill,
  useSkills,
  useSkillVisibility,
} from "@/hooks/useSkills";
import { applyBulkAction } from "@/lib/bulk-actions";
import { readPrimitiveFolder } from "@/lib/primitive-files";
import { useViewParam } from "@/lib/view-params";

type SourceFilter = "all" | "builtin" | "user";
type RepositorySort = "default" | "asc" | "desc";

const REPOSITORY_SORT_ORDER: Record<RepositorySort, "none" | "ascending" | "descending"> = {
  default: "none",
  asc: "ascending",
  desc: "descending",
};
const REPOSITORY_SORT_ICONS = { default: ArrowUpDown, asc: ArrowUp, desc: ArrowDown };

const SOURCE_FILTERS: Array<{ value: SourceFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "builtin", label: "Built-in" },
  { value: "user", label: "User" },
];

const SOURCE_COLORS: Record<SkillSource, string> = {
  builtin: "text-muted-foreground",
  user: "text-muted-foreground",
};

export default function Skills({ projectId }: { projectId: string }) {
  const project = useProjectScope(projectId);
  const scope: ScopeQuery =
    project === "all" || project === "unassigned" ? { scope: "global" } : { project_id: project };
  const [query, setQuery] = useViewParam<string>("skillQuery", "");
  const [searchInput, setSearchInput] = useState(query);
  const [sourceFilter, setSourceFilter] = useViewParam<SourceFilter>("source", "all", [
    "all",
    "builtin",
    "user",
  ]);
  const [repositorySort, setRepositorySort] = useViewParam<RepositorySort>(
    "skillRepositorySort",
    "default",
    ["default", "asc", "desc"],
  );
  const RepositorySortIcon = REPOSITORY_SORT_ICONS[repositorySort];
  useEffect(() => setSearchInput(query), [query]);
  const {
    selectedId: selectedSkill,
    openDetail: openSkillDetail,
    closeDetail: closeSkillDetail,
  } = useDetailRoute("/skills", "skillName");
  const [creating, setCreating] = useState(false);
  const [importingRepository, setImportingRepository] = useState(false);
  const [importingLocal, setImportingLocal] = useState(false);
  const visibility = useSkillVisibility();
  const setVisibility = useSetSkillVisibility();

  const {
    data: library,
    isLoading,
    error,
    refetch,
  } = useSkills({
    ...scope,
    q: query || undefined,
    source: sourceFilter === "all" ? undefined : sourceFilter,
    include_hidden: true,
  });
  const skills = library?.skills;
  const queryClient = useQueryClient();
  const userSkills = (skills ?? []).filter((skill) => skill.source === "user");
  const origins = useQueries({
    queries: userSkills.map((skill) => ({
      queryKey: ["skill-origin", skill.name],
      queryFn: () => api.skills.origin(skill.name),
    })),
  });
  const importedNames = userSkills
    .filter((_, index) => Boolean(origins[index]?.data))
    .map((skill) => skill.name);
  const repositoryByName = new Map(
    userSkills.map((skill, index) => [skill.name, origins[index]?.data?.repository]),
  );
  const displayedSkills = [...(skills ?? [])];
  if (repositorySort !== "default") {
    displayedSkills.sort((left, right) => {
      const leftRepository = repositoryByName.get(left.name);
      const rightRepository = repositoryByName.get(right.name);
      if (!leftRepository && rightRepository) return 1;
      if (leftRepository && !rightRepository) return -1;
      const compared = (leftRepository ?? "").localeCompare(rightRepository ?? "", undefined, {
        sensitivity: "base",
      });
      if (compared) return repositorySort === "asc" ? compared : -compared;
      return left.name.localeCompare(right.name);
    });
  }
  const selectionScope = JSON.stringify([project, query, sourceFilter]);
  const currentScope = useRef(selectionScope);
  currentScope.current = selectionScope;
  const selection = useListSelection(importedNames, selectionScope);
  const bulkSync = useMutation({
    mutationFn: async ({ names, scope }: { names: string[]; scope: string }) => ({
      ...(await applyBulkAction(names, async (name) => {
        const result = await api.skills.sync(name);
        if (!result.applied)
          throw new Error(`Conflicts: ${result.conflicts.join(", ")}. Open this skill to review.`);
      })),
      scope,
    }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["skills"] }),
        queryClient.invalidateQueries({ queryKey: ["skill"] }),
        queryClient.invalidateQueries({ queryKey: ["skill-origin"] }),
      ]);
    },
  });
  const bulkResult = bulkSync.data?.scope === selectionScope ? bulkSync.data : undefined;
  async function syncSelected(): Promise<void> {
    const result = await bulkSync.mutateAsync({
      names: selection.selectedIds,
      scope: selectionScope,
    });
    if (result.scope === currentScope.current)
      selection.select(result.failed.map((item) => item.id));
  }

  if (error) return <ErrorState message={(error as Error).message} onRetry={() => refetch()} />;

  return (
    <div>
      <ViewHeader
        title="Skills"
        meta={`${(skills ?? []).length} skills`}
        action={
          <div className="flex flex-wrap gap-2">
            <Button
              data-testid="import-skill-button"
              size="sm"
              variant="outline"
              onClick={() => setImportingRepository(true)}
            >
              <Download size={12} className="mr-1" /> Import from GitHub
            </Button>
            <Button
              data-testid="import-local-skills-button"
              size="sm"
              variant="outline"
              onClick={() => setImportingLocal(true)}
            >
              <Download size={12} className="mr-1" /> Import from agents
            </Button>
            <Button
              data-testid="new-skill-button"
              size="sm"
              onClick={() => setCreating(true)}
              className="font-label text-sm  "
            >
              <Plus size={12} className="mr-1" /> New skill
            </Button>
          </div>
        }
      />

      <p className="text-xs text-muted-foreground mb-3">
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
      <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
        Built-in visibility applies to agent discovery across this installation. Hidden skills
        remain readable by name and available to flows. Authored overrides stay visible.
      </p>
      {(visibility.error || setVisibility.error) && (
        <p role="alert" className="text-destructive text-xs mb-2">
          {(visibility.error || setVisibility.error)?.message}
        </p>
      )}
      {library?.broken?.map((issue) => (
        <p key={issue.path} role="alert" className="text-destructive text-xs mb-2">
          {issue.path}: {issue.error}
        </p>
      ))}

      {/* Source filter pills */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="flex shrink-0 flex-wrap gap-1.5">
          {SOURCE_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setSourceFilter(f.value)}
              data-testid={`skill-source-${f.value}`}
              aria-pressed={sourceFilter === f.value}
              className={`font-label text-sm  px-3 py-1.5 border transition-colors ${
                sourceFilter === f.value
                  ? "bg-surface-highest text-on-surface border-transparent"
                  : "bg-transparent border-transparent text-muted-foreground hover:bg-surface-low hover:text-on-surface"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="relative min-w-[160px] flex-1">
          <Search
            size={12}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            data-testid="skill-search-input"
            aria-label="Search skills"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setQuery(e.currentTarget.value)}
            placeholder="Search skills..."
            className="pl-8 bg-background text-on-surface font-body text-sm placeholder:text-muted-foreground"
          />
        </div>
        <Button
          data-testid="skill-search-submit"
          variant="outline"
          size="sm"
          onClick={() => setQuery(searchInput)}
          className="font-label text-sm "
        >
          Search
        </Button>
      </div>

      {!!importedNames.length && (
        <BulkActionBar
          resourceLabel="GitHub skills"
          count={selection.selectedIds.length}
          allSelected={selection.allSelected}
          someSelected={selection.someSelected}
          onSelectAll={selection.selectAll}
          onClear={selection.clear}
          disabled={bulkSync.isPending || origins.some((origin) => origin.isPending)}
        >
          <Button
            data-testid="skills-bulk-sync"
            variant="outline"
            size="sm"
            disabled={bulkSync.isPending}
            onClick={() => void syncSelected()}
          >
            {bulkSync.isPending ? "Syncing…" : "Sync selected from GitHub"}
          </Button>
          <span className="text-xs text-muted-foreground">
            Local edits are preserved; conflicts require review.
          </span>
        </BulkActionBar>
      )}
      {origins.some((origin) => origin.error) && (
        <p role="alert" className="text-sm text-destructive">
          Could not check GitHub origins: {origins.find((origin) => origin.error)?.error?.message}
        </p>
      )}
      {bulkResult && (
        <div data-testid="skills-bulk-result" role="status" className="mb-3 text-sm">
          <p>
            {bulkResult.succeeded.length} synced; {bulkResult.failed.length} need attention.
          </p>
          {bulkResult.failed.map((item) => (
            <button
              key={item.id}
              type="button"
              className="block text-left text-destructive underline"
              onClick={() => openSkillDetail(item.id)}
            >
              {item.id}: {item.error}
            </button>
          ))}
        </div>
      )}
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
        <div className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-outline-variant hover:bg-transparent">
                <TableHead className="w-12">
                  <span className="sr-only">Select GitHub skills</span>
                </TableHead>
                <TableHead className="font-label text-sm  text-muted-foreground">Name</TableHead>
                <TableHead className="font-label text-sm  text-muted-foreground">
                  Description
                </TableHead>
                <TableHead className="font-label text-sm  text-muted-foreground w-24">
                  Source
                </TableHead>
                <TableHead
                  data-testid="skill-repository-header"
                  aria-sort={REPOSITORY_SORT_ORDER[repositorySort]}
                >
                  <button
                    type="button"
                    data-testid="skill-repository-sort"
                    className="flex min-h-11 items-center gap-2 text-sm text-muted-foreground hover:text-on-surface"
                    onClick={() => {
                      if (repositorySort === "default") setRepositorySort("asc");
                      else if (repositorySort === "asc") setRepositorySort("desc");
                      else setRepositorySort("default");
                    }}
                    title="Sort by GitHub repository: ascending, descending, then default order"
                  >
                    GitHub repository <RepositorySortIcon size={14} aria-hidden="true" />
                  </button>
                </TableHead>
                <TableHead className="text-xs text-muted-foreground">Agent discovery</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {displayedSkills.map((skill) => (
                <TableRow
                  key={skill.name}
                  data-testid="skill-row"
                  data-skill-name={skill.name}
                  className="border-b border-outline-variant/50 hover:bg-surface-low cursor-pointer"
                  onClick={() => openSkillDetail(skill.name)}
                >
                  <TableCell onClick={(event) => event.stopPropagation()}>
                    {importedNames.includes(skill.name) && (
                      <input
                        type="checkbox"
                        data-testid="skill-select"
                        aria-label={`Select ${skill.name}`}
                        checked={selection.selectedIds.includes(skill.name)}
                        disabled={bulkSync.isPending}
                        onChange={() => selection.toggle(skill.name)}
                        className="size-4 accent-primary"
                      />
                    )}
                  </TableCell>
                  <TableCell className="font-body text-sm font-medium text-on-surface">
                    <button
                      type="button"
                      className="min-h-11 text-left hover:text-primary"
                      onClick={(event) => {
                        event.stopPropagation();
                        openSkillDetail(skill.name);
                      }}
                    >
                      {skill.name}
                    </button>
                    {skill.mutation && <span className="ml-2 text-primary text-xs">Mutated</span>}
                  </TableCell>
                  <TableCell className="font-body text-sm text-muted-foreground max-w-md truncate">
                    {skill.description || "\u2014"}
                  </TableCell>
                  <TableCell data-testid="skill-source-cell">
                    <span
                      className={`inline-flex py-0.5 font-label text-sm ${SOURCE_COLORS[skill.source]}`}
                    >
                      {skill.source}
                    </span>
                  </TableCell>
                  <TableCell
                    data-testid="skill-repository-cell"
                    onClick={(event) => event.stopPropagation()}
                    className="max-w-56 truncate text-sm text-muted-foreground"
                  >
                    {repositoryByName.get(skill.name) ? (
                      <a
                        data-testid="skill-repository-link"
                        href={`https://github.com/${repositoryByName.get(skill.name)}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline"
                        title={repositoryByName.get(skill.name)}
                      >
                        {repositoryByName.get(skill.name)}
                      </a>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell onClick={(event) => event.stopPropagation()}>
                    {skill.source === "builtin" && !skill.mutation ? (
                      <button
                        type="button"
                        role="switch"
                        aria-label={`${skill.name} visible to agents`}
                        aria-checked={!skill.discovery_hidden}
                        data-testid={`skill-visibility-${skill.name}`}
                        disabled={!visibility.data || setVisibility.isPending}
                        className="inline-flex min-h-11 items-center gap-2 text-xs text-primary disabled:opacity-50"
                        title={
                          skill.discovery_hidden
                            ? "Show in agent discovery"
                            : "Hide from agent discovery"
                        }
                        onClick={() => {
                          const hidden = new Set(visibility.data?.hidden_builtins ?? []);
                          if (hidden.has(skill.name)) hidden.delete(skill.name);
                          else hidden.add(skill.name);
                          setVisibility.mutate([...hidden]);
                        }}
                      >
                        {skill.discovery_hidden ? (
                          <ToggleLeft
                            size={22}
                            aria-hidden="true"
                            className="text-muted-foreground"
                          />
                        ) : (
                          <ToggleRight size={22} aria-hidden="true" />
                        )}
                        {skill.discovery_hidden ? "Hidden" : "Visible"}
                      </button>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {skill.mutation ? "Visible (override)" : "Visible"}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <SkillDetailSheet
        key={selectedSkill}
        scope={scope}
        skillName={selectedSkill}
        open={Boolean(selectedSkill)}
        onClose={closeSkillDetail}
      />

      {creating && <CreateSkillDialog open={creating} onClose={() => setCreating(false)} />}
      {importingRepository && <ImportSkillDialog onClose={() => setImportingRepository(false)} />}
      {importingLocal && <ImportLocalSkillsDialog onClose={() => setImportingLocal(false)} />}
    </div>
  );
}

function SkillDetailSheet({
  skillName,
  scope,
  open,
  onClose,
}: {
  skillName: string | null;
  scope: ScopeQuery;
  open: boolean;
  onClose: () => void;
}) {
  const { data, isLoading, error, refetch } = useSkill(skillName, undefined, scope);
  const skill = data as SkillFull | undefined;
  const [selectedFile, setSelectedFile] = useViewParam<string>("skillFile", "SKILL.md");
  const fileQuery = useSkill(skillName, selectedFile ?? "SKILL.md", scope);
  const file = fileQuery.data as SkillRefContent | undefined;
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const documentId = `skill:${scope.project_id ?? "global"}:${skillName}:${selectedFile ?? "SKILL.md"}`;
  function selectFile(path?: string): boolean {
    if ((path ?? "SKILL.md") === (selectedFile ?? "SKILL.md")) return true;
    if (!confirmDocumentClose(documentId)) return false;
    setSelectedFile(path ?? "SKILL.md");
    return true;
  }
  const navigation = skill ? (
    <DocumentTabs
      files={["SKILL.md", ...(skill.files ?? []).map((entry) => entry.name)]}
      selected={selectedFile ?? "SKILL.md"}
      onSelect={(path) => selectFile(path === "SKILL.md" ? undefined : path)}
      testId="skill-file"
      entryTestId="skill-show-entry"
    />
  ) : null;

  return (
    <Sheet open={open} onOpenChange={(v) => !v && confirmDocumentClose(documentId) && onClose()}>
      <SheetContent className="w-screen max-w-full sm:w-[1120px] sm:max-w-[96vw]">
        <SheetHeader>
          <SheetTitle>{skill?.name ?? "Skill Details"}</SheetTitle>
          {skill?.description && (
            <p className="font-body text-sm text-muted-foreground mt-1">{skill.description}</p>
          )}
        </SheetHeader>
        <SheetBody>
          {
            <>
              {skillName && skill && (
                <SkillHistoryPanel name={skillName} scope={scope} mutation={skill.mutation} />
              )}
              {skillName && skill && <SkillSync name={skillName} />}
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
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <DetailField label="Source">
                      <span
                        className={`inline-flex py-0.5 font-label text-sm ${SOURCE_COLORS[skill.source]}`}
                      >
                        {skill.source}
                      </span>
                    </DetailField>
                    <DetailField label="Path">
                      <code className="font-mono text-sm text-muted-foreground break-all">
                        {skill.path}
                      </code>
                    </DetailField>
                  </div>

                  <div>
                    <div className="font-label text-sm  text-muted-foreground mb-2">
                      {selectedFile ?? "SKILL.md"}
                    </div>
                    <div className="overflow-hidden">
                      {file?.encoding === "base64" && <div className="p-3">{navigation}</div>}
                      {fileQuery.error ? (
                        <p role="alert">{(fileQuery.error as Error).message}</p>
                      ) : fileQuery.isLoading ? (
                        <p>Loading...</p>
                      ) : file?.encoding === "base64" ? (
                        <CodeEditor
                          path={selectedFile ?? "SKILL.md"}
                          value={file?.content ?? ""}
                          readOnly
                          hidePreview
                          height={400}
                          testId="skill-file-content"
                        />
                      ) : (
                        <DocumentWorkspace
                          key={documentId}
                          documentId={documentId}
                          expanded={expanded}
                          onExpandedChange={setExpanded}
                          navigation={navigation}
                          path={selectedFile ?? "SKILL.md"}
                          content={file?.content ?? ""}
                          testId="skill-file-content"
                          onSave={
                            skill.source === "user" && file?.encoding === "utf8"
                              ? async (content, expectedContent) => {
                                  const path = selectedFile ?? "SKILL.md";
                                  if (skill.mutation && path === "SKILL.md") {
                                    await api.skills.updateInstructions(skill.name, {
                                      project_id: scope.project_id ?? null,
                                      content,
                                      expected_content: expectedContent,
                                      reason: "Manual instruction edit",
                                      author: "human",
                                    });
                                  } else
                                    await api.skills.editFile(skill.name, {
                                      path,
                                      content,
                                      expectedContent,
                                    });
                                  await queryClient.invalidateQueries({
                                    queryKey: ["skill", skill.name],
                                  });
                                  await queryClient.invalidateQueries({ queryKey: ["skills"] });
                                  await queryClient.invalidateQueries({
                                    queryKey: ["skill-history", skill.name],
                                  });
                                  return content;
                                }
                              : undefined
                          }
                        />
                      )}
                      {file?.encoding === "base64" && (
                        <p className="p-4 text-xs text-muted-foreground">
                          Binary asset shown as base64 (read-only).
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </>
          }
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
    Array<{
      id: string;
      path: string;
      content: string;
      encoding: "utf8" | "base64";
    }>
  >([]);
  const [importError, setImportError] = useState<string>();
  const [importing, setImporting] = useState(false);
  const dirty = Boolean(name || content || files.length);
  useEffect(() => {
    if (!dirty) return;
    function warn(event: BeforeUnloadEvent): void {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function close(): void {
    if (createSkill.isPending || importing) return;
    if (!dirty || window.confirm("Discard this unsaved skill?")) onClose();
  }

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

  const handleSubmit = () => {
    if (
      !name.trim() ||
      !content.trim() ||
      createSkill.isPending ||
      importing ||
      files.some((file) => !file.path.trim())
    )
      return;
    createSkill.mutate(
      {
        name: name.trim(),
        content: content.trim(),
        files: files.map(({ path, content, encoding }) => ({
          path,
          content,
          encoding,
        })),
      },
      { onSuccess: onClose },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent className="bg-surface border-outline-variant w-[calc(100%_-_1rem)] max-w-5xl max-h-[94dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-headline text-base  text-on-surface">New skill</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            handleSubmit();
          }}
          className="space-y-3 mt-2"
        >
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
            <Label className="font-label text-sm  text-muted-foreground">Name *</Label>
            <Input
              aria-label="Name"
              data-testid="skill-name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-skill"
              className="bg-background text-on-surface font-body text-sm"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label className="font-label text-sm  text-muted-foreground">SKILL.md *</Label>
            <MarkdownEditor
              testId="skill-content-input"
              path="SKILL.md"
              value={content}
              onChange={setContent}
              onSave={handleSubmit}
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
                  {
                    id: crypto.randomUUID(),
                    path: "",
                    content: "",
                    encoding: "utf8",
                  },
                ])
              }
            >
              Add file
            </Button>
            {files.map((file) => (
              <div
                key={file.id}
                data-testid="skill-supporting-file"
                className="space-y-2 border border-outline-variant p-3"
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
                <CodeEditor
                  testId="skill-file-content-input"
                  path={file.path || "supporting.txt"}
                  readOnly={file.encoding === "base64"}
                  label={`Content of ${file.path || "supporting file"}`}
                  value={file.content}
                  height={180}
                  onChange={(value) =>
                    setFiles(
                      files.map((item) =>
                        item.id === file.id ? { ...item, content: value } : item,
                      ),
                    )
                  }
                />
                {file.encoding === "base64" && (
                  <p className="text-xs text-muted-foreground">Binary asset (base64)</p>
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
              onClick={close}
              className="font-label text-sm text-muted-foreground"
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
              className="font-label text-sm "
            >
              {createSkill.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
