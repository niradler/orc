import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { stringify as stringifyYaml } from "yaml";
import { api, type SkillFileInput } from "@/api/client";
import { CodeEditor } from "@/components/CodeEditor";
import { PackageFileTabs } from "@/components/PackageFileTabs";
import { Button } from "@/components/ui/button";
import {
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  MCP_SCHEMA,
  type PackageFormat,
  type PackageInput,
  packageFields,
  packageTemplate,
  replacePackageFile,
  setInstructionBody,
  setPackageField,
  setPackageMcp,
  validatePackageDraft,
} from "@/lib/package-draft";
import { readPrimitiveFolder } from "@/lib/primitive-files";
import { useViewParam } from "@/lib/view-params";

type Draft = {
  name: string;
  content: string;
  format: PackageFormat;
  files: SkillFileInput[];
  revision?: string;
};
type EditorDraft = {
  format?: PackageFormat;
  source: string;
  files: SkillFileInput[];
  selectedSkills: string[];
  mcpDraft?: string;
  baseline?: Draft;
};
const packageDrafts = new Map<string, EditorDraft>();
if (typeof window !== "undefined")
  window.addEventListener("beforeunload", (event) => {
    if (!packageDrafts.size) return;
    event.preventDefault();
    event.returnValue = "";
  });
export function forgetPackageDraft(name: string): void {
  packageDrafts.delete(name);
}
export function getPackageDraftBase(name: string): Draft | undefined {
  return packageDrafts.get(name)?.baseline;
}
export function confirmPackageDraftClose(name: string): boolean {
  if (!packageDrafts.has(name)) return true;
  if (!window.confirm("Discard unsaved package changes?")) return false;
  forgetPackageDraft(name);
  return true;
}
const INSTRUCTIONS = ".apm/instructions/general.instructions.md";

export function PackageEditor({
  initial,
  pending,
  error,
  onSave,
}: {
  initial?: Draft;
  pending: boolean;
  error?: string;
  onSave: (input: PackageInput) => void;
}) {
  const [formatParam, setFormatParam] = useViewParam<string>("packageFormat", "", [
    "",
    "apm",
    "agent-plugin",
  ]);
  const restored = useRef(packageDrafts.get(initial?.name ?? "new"));
  const initialFormat =
    initial?.format ?? ((formatParam || undefined) as PackageFormat | undefined);
  const [format, setFormat] = useState<PackageFormat | undefined>(
    restored.current?.format ?? initialFormat,
  );
  useEffect(() => {
    if (!initial?.format) setFormat((formatParam || undefined) as PackageFormat | undefined);
  }, [formatParam, initial?.format]);
  const [source, setSource] = useState(
    restored.current?.source ?? initial?.content ?? packageTemplate(initialFormat ?? "apm"),
  );
  const [files, setFiles] = useState<SkillFileInput[]>(
    restored.current?.files ?? initial?.files ?? [],
  );
  const [selectedSkills, setSelectedSkills] = useState<string[]>(
    restored.current?.selectedSkills ?? [],
  );
  const [skillSearch, setSkillSearch] = useState("");
  const [tab, setTab] = useViewParam<string>("packageTab", initial ? "files" : "configuration", [
    "files",
    "configuration",
    "skills",
  ]);
  const [sourceMode, setSourceMode] = useViewParam<string>("packageSource", "fields", [
    "fields",
    "source",
  ]);
  const advanced = sourceMode === "source";
  const setAdvanced = (value: boolean) => setSourceMode(value ? "source" : "fields");
  const [localError, setLocalError] = useState<string>();
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [mcpDraft, setMcpDraft] = useState<string | undefined>(restored.current?.mcpDraft);
  const [mcpError, setMcpError] = useState<string>();
  const skills = useQuery({ queryKey: ["package-skill-picker"], queryFn: () => api.skills.list() });
  const agents = useQuery({ queryKey: ["agents"], queryFn: api.agents.list });
  const parsed = useMemo(() => {
    try {
      return { fields: packageFields(source, format ?? "apm"), error: undefined };
    } catch (failure) {
      return { fields: undefined, error: (failure as Error).message };
    }
  }, [source, format]);
  const fields = parsed.fields;
  const name = typeof fields?.name === "string" ? fields.name : "";
  const busy = pending || loadingFiles;
  const instructionFile = files.find((file) => file.path === INSTRUCTIONS);
  const instructionText =
    instructionFile?.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "") ?? "";
  const mcpFile = files.find((file) => file.path === "mcp.json");
  useEffect(() => {
    const dirty =
      source !== (initial?.content ?? packageTemplate(format ?? "apm")) ||
      JSON.stringify(files) !== JSON.stringify(initial?.files ?? []) ||
      selectedSkills.length > 0 ||
      mcpDraft !== undefined;
    if (dirty)
      packageDrafts.set(initial?.name ?? "new", {
        format:
          format ?? packageDrafts.get(initial?.name ?? "new")?.format ?? restored.current?.format,
        source,
        files,
        selectedSkills,
        mcpDraft,
        baseline: restored.current?.baseline ?? initial,
      });
    else packageDrafts.delete(initial?.name ?? "new");
  }, [source, files, selectedSkills, mcpDraft, format, initial]);

  function change(key: string, value: unknown) {
    try {
      setSource(setPackageField(source, format ?? "apm", key, value));
      setLocalError(undefined);
    } catch (failure) {
      setLocalError((failure as Error).message);
    }
  }
  function selectFormat(value: PackageFormat) {
    const retained = packageDrafts.get(initial?.name ?? "new");
    if (retained && retained.format === value) {
      setFormat(value);
      setFormatParam(value);
      setSource(retained.source);
      setFiles(retained.files);
      setSelectedSkills(retained.selectedSkills);
      setMcpDraft(retained.mcpDraft);
      return;
    }
    if (retained && !confirmPackageDraftClose(initial?.name ?? "new")) return;
    setFormat(value);
    setFormatParam(value);
    setSource(packageTemplate(value));
    setFiles([]);
    setSelectedSkills([]);
    setMcpDraft(undefined);
  }

  return (
    <DialogContent className="min-w-0 grid-cols-[minmax(0,1fr)] w-[calc(100%_-_1rem)] max-w-4xl max-h-[94dvh] overflow-x-hidden overflow-y-auto p-4 sm:p-6">
      <DialogHeader>
        <DialogTitle className="break-words pr-8">
          {initial ? `Edit ${initial.name}` : "New package"}
        </DialogTitle>
        <DialogDescription>
          Save a configuration once, then use it in any project.
        </DialogDescription>
      </DialogHeader>
      {!format ? (
        <div className="grid gap-3 sm:grid-cols-2" data-testid="package-type-choice">
          <button
            type="button"
            data-testid="package-type-apm"
            onClick={() => selectFormat("apm")}
            className="rounded-lg border border-surface-highest p-5 text-left hover:border-primary"
          >
            <strong className="block mb-2">APM package</strong>
            <span className="text-sm text-outline">
              Instructions, agents, skills, MCP and dependencies. Configure with apm.yml.
            </span>
          </button>
          <button
            type="button"
            data-testid="package-type-agent-plugin"
            onClick={() => selectFormat("agent-plugin")}
            className="rounded-lg border border-surface-highest p-5 text-left hover:border-primary"
          >
            <strong className="block mb-2">Agent Plugin</strong>
            <span className="text-sm text-outline">
              Portable skills and MCP. Configure with plugin.json and mcp.json.
            </span>
          </button>
        </div>
      ) : (
        <form
          className="min-w-0 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (mcpError) return;
            setLocalError(undefined);
            try {
              const validated = validatePackageDraft(source, format);
              if (format === "agent-plugin" && mcpFile) JSON.parse(mcpFile.content);
              onSave({
                name: validated.name as string,
                content: source,
                files,
                format,
                skills: selectedSkills,
              });
            } catch (failure) {
              setLocalError((failure as Error).message);
            }
          }}
        >
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="rounded bg-surface-high px-3 py-1">
              {format === "apm" ? "APM" : "Plugin"}
            </span>
            {!initial && (
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  if (!confirmPackageDraftClose("new")) return;
                  setFormat(undefined);
                  setFormatParam("");
                  setSource(packageTemplate("apm"));
                  setFiles([]);
                  setSelectedSkills([]);
                  setMcpDraft(undefined);
                }}
              >
                Change type
              </Button>
            )}
          </div>
          <div
            role="tablist"
            aria-label="Package editor"
            className="flex flex-wrap gap-1 border-b border-surface-highest pb-2"
          >
            {["configuration", "skills", "files"].map((value) => (
              <Button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                variant={tab === value ? "default" : "ghost"}
                data-testid={`package-editor-${value}`}
                onClick={() => setTab(value)}
              >
                {value[0]?.toUpperCase()}
                {value.slice(1)}
                {value === "skills" && selectedSkills.length ? ` (${selectedSkills.length})` : ""}
              </Button>
            ))}
          </div>
          <fieldset disabled={busy} className="min-w-0 space-y-4">
            {tab === "configuration" && (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm text-outline">
                    {format === "apm" ? "APM configuration" : "Portable plugin identity"}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    data-testid="package-editor-mode"
                    disabled={Boolean(mcpError) || (advanced && Boolean(parsed.error))}
                    onClick={() => {
                      setAdvanced(!advanced);
                      setMcpDraft(undefined);
                    }}
                  >
                    {advanced ? "Edit fields" : format === "apm" ? "Edit YAML" : "Edit JSON"}
                  </Button>
                </div>
                {advanced ? (
                  <CodeEditor
                    id="package-yaml"
                    testId="package-yaml-input"
                    path={format === "apm" ? "apm.yml" : "plugin.json"}
                    value={source}
                    onChange={setSource}
                    readOnly={busy}
                    height={320}
                  />
                ) : (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {(
                        [
                          ["name", "Package name"],
                          ["version", "Version"],
                          ["description", "When would you use this?"],
                        ] as const
                      ).map(([key, label]) => (
                        <div
                          key={key}
                          className={
                            key === "description" ? "space-y-1 sm:col-span-2" : "space-y-1"
                          }
                        >
                          <Label htmlFor={`package-${key}`}>{label}</Label>
                          <Input
                            id={`package-${key}`}
                            data-testid={`package-${key}-input`}
                            disabled={key === "name" && Boolean(initial)}
                            value={typeof fields?.[key] === "string" ? fields[key] : ""}
                            onChange={(event) => change(key, event.target.value)}
                          />
                        </div>
                      ))}
                    </div>
                    {format === "apm" ? (
                      <>
                        <div className="space-y-1">
                          <Label htmlFor="package-apm-mcp">MCP servers (YAML declarations)</Label>
                          <CodeEditor
                            id="package-apm-mcp"
                            path="mcp-dependencies.yml"
                            testId="package-apm-mcp"
                            height={180}
                            readOnly={busy}
                            value={
                              mcpDraft ??
                              stringifyYaml(
                                (fields?.dependencies as Record<string, unknown> | undefined)
                                  ?.mcp ?? [],
                              )
                            }
                            onChange={(value) => {
                              setMcpDraft(value);
                              try {
                                setSource(setPackageMcp(source, value));
                                setMcpError(undefined);
                              } catch (failure) {
                                setMcpError((failure as Error).message);
                              }
                            }}
                          />
                          <p className="text-xs text-outline">
                            Use registry names, or named APM mappings with transport and
                            command/URL. Credentials use environment references such as{" "}
                            <code>
                              {"$"}
                              {"{API_TOKEN}"}
                            </code>
                            .
                          </p>
                          {mcpError && (
                            <p role="alert" className="text-sm text-destructive">
                              {mcpError}
                            </p>
                          )}
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="package-instructions">Shared instructions</Label>
                          <Textarea
                            id="package-instructions"
                            data-testid="package-instructions"
                            rows={7}
                            placeholder="What should the agent know and how should it work?"
                            value={instructionText}
                            onChange={(event) =>
                              setFiles(
                                replacePackageFile(
                                  files,
                                  INSTRUCTIONS,
                                  setInstructionBody(instructionFile?.content, event.target.value),
                                ),
                              )
                            }
                          />
                          <p className="text-xs text-outline">
                            Saved as an APM instruction primitive. Agent-specific model and tool
                            configuration belongs in an agent definition.
                          </p>
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="package-agent-picker">
                            Add an existing agent definition
                          </Label>
                          <select
                            id="package-agent-picker"
                            data-testid="package-agent-picker"
                            className="w-full rounded border border-surface-highest bg-surface-low p-3"
                            value=""
                            onChange={async (event) => {
                              const id = event.target.value;
                              if (!id) return;
                              setLoadingFiles(true);
                              try {
                                const agent = await api.agents.get(id);
                                const filename =
                                  id
                                    .split("/")
                                    .slice(-1)[0]
                                    ?.replace(/[^a-zA-Z0-9-]/g, "-") ?? "agent";
                                setFiles((current) =>
                                  replacePackageFile(
                                    current,
                                    `.apm/agents/${filename}.agent.md`,
                                    agent.raw,
                                  ),
                                );
                              } catch (failure) {
                                setLocalError((failure as Error).message);
                              } finally {
                                setLoadingFiles(false);
                              }
                            }}
                          >
                            <option value="">Select an agent to copy into this package…</option>
                            {agents.data?.agents.map((agent) => (
                              <option value={agent.id} key={agent.id}>
                                {agent.name}
                              </option>
                            ))}
                          </select>
                        </div>
                        <p className="text-sm text-outline">
                          Configure targets, MCP dependencies and launch scripts in Edit YAML.
                          Supporting agent files are editable in Files.
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="text-sm text-outline">
                          Agent Plugins v1 contains skills and MCP. Choose APM if you need shared
                          instructions or agent profiles.
                        </p>
                        <div className="space-y-1">
                          <Label>mcp.json (optional)</Label>
                          <CodeEditor
                            path="mcp.json"
                            testId="package-mcp-input"
                            height={220}
                            value={
                              mcpFile?.content ??
                              JSON.stringify({ $schema: MCP_SCHEMA, mcpServers: {} }, null, 2)
                            }
                            readOnly={busy}
                            onChange={(content) =>
                              setFiles(replacePackageFile(files, "mcp.json", content))
                            }
                          />
                          <p className="text-xs text-outline">
                            Credentials are managed by the coding agent. Keep secrets out of package
                            files.
                          </p>
                        </div>
                      </>
                    )}
                  </>
                )}
              </>
            )}
            {tab === "skills" && (
              <>
                {files
                  .filter((file) => /^(skills|\.apm\/skills)\/[^/]+\/SKILL\.md$/.test(file.path))
                  .map((file) => {
                    const prefix = file.path.slice(0, -"SKILL.md".length);
                    return (
                      <div
                        key={file.path}
                        className="flex flex-wrap items-center justify-between gap-2 rounded border border-surface-highest p-3"
                      >
                        <span className="min-w-0 break-words text-sm">
                          Included: {prefix.split("/").slice(-2)[0]}
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          data-testid="package-skill-remove"
                          onClick={() =>
                            setFiles((current) =>
                              current.filter((item) => !item.path.startsWith(prefix)),
                            )
                          }
                        >
                          Remove from package
                        </Button>
                      </div>
                    );
                  })}
                <p className="text-sm text-outline">
                  Choose skills from your library. Their SKILL.md, scripts, references and assets
                  are copied into this package; the originals stay available independently.
                </p>
                <Input
                  aria-label="Search existing skills"
                  data-testid="package-skill-search"
                  placeholder="Search your skills…"
                  value={skillSearch}
                  onChange={(event) => setSkillSearch(event.target.value)}
                />
                {skills.error && <p role="alert">{skills.error.message}</p>}
                {skills.isLoading && <p>Loading skills…</p>}
                <div className="max-h-[40dvh] overflow-auto space-y-2">
                  {skills.data?.skills
                    .filter((skill) =>
                      `${skill.name} ${skill.description}`
                        .toLowerCase()
                        .includes(skillSearch.toLowerCase()),
                    )
                    .map((skill) => {
                      const localName = skill.name.split("/").slice(-1)[0];
                      const alreadyIncluded = files.some(
                        (file) =>
                          file.path ===
                          `${format === "apm" ? ".apm/skills" : "skills"}/${localName}/SKILL.md`,
                      );
                      return (
                        <label
                          key={skill.name}
                          className="flex items-start gap-3 rounded border border-surface-highest p-3"
                          data-testid="package-skill-option"
                          data-skill-name={skill.name}
                        >
                          <input
                            type="checkbox"
                            className="mt-1 size-5 shrink-0"
                            data-testid="package-skill-select"
                            checked={alreadyIncluded || selectedSkills.includes(skill.name)}
                            disabled={
                              alreadyIncluded ||
                              busy ||
                              (!selectedSkills.includes(skill.name) && selectedSkills.length >= 32)
                            }
                            onChange={(event) =>
                              setSelectedSkills(
                                event.target.checked
                                  ? [...selectedSkills, skill.name]
                                  : selectedSkills.filter((name) => name !== skill.name),
                              )
                            }
                          />
                          <span className="min-w-0 break-words">
                            <span className="block text-sm font-medium">
                              {skill.name}
                              {alreadyIncluded ? " · included" : ""}
                            </span>
                            <span className="block text-xs text-outline line-clamp-2">
                              {skill.description}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                </div>
                {!skills.isLoading && skills.data?.skills.length === 0 && (
                  <p>
                    No skills yet. Import skills into your library first, or add skill files
                    directly in Files.
                  </p>
                )}
              </>
            )}
            {tab === "files" && (
              <>
                <details className="rounded border border-surface-highest p-3">
                  <summary className="cursor-pointer text-sm">Add a file or folder</summary>
                  <Label htmlFor="package-files">Add files from a folder</Label>
                  <Input
                    id="package-files"
                    data-testid="package-files-input"
                    type="file"
                    multiple
                    {...{ webkitdirectory: "" }}
                    onChange={async (event) => {
                      const selected = event.target.files;
                      if (!selected?.length) return;
                      setLoadingFiles(true);
                      try {
                        const incoming = (await readPrimitiveFolder(selected)).filter(
                          (file) => !["apm.yml", "plugin.json"].includes(file.path),
                        );
                        setFiles((current) => [
                          ...current.filter(
                            (file) => !incoming.some((item) => item.path === file.path),
                          ),
                          ...incoming,
                        ]);
                        setLocalError(undefined);
                      } catch (failure) {
                        setLocalError((failure as Error).message);
                      } finally {
                        setLoadingFiles(false);
                      }
                    }}
                  />
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      aria-label="New file path"
                      data-testid="package-new-file-path"
                      placeholder={
                        format === "apm"
                          ? ".apm/agents/reviewer.agent.md"
                          : "skills/my-skill/SKILL.md"
                      }
                      value={newPath}
                      onChange={(event) => setNewPath(event.target.value)}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!newPath || files.some((file) => file.path === newPath)}
                      onClick={() => {
                        setFiles((current) => [
                          ...current,
                          { path: newPath, content: "", encoding: "utf8" },
                        ]);
                        setNewPath("");
                      }}
                    >
                      Add file
                    </Button>
                  </div>
                </details>
                <PackageFileTabs
                  files={[
                    { path: format === "apm" ? "apm.yml" : "plugin.json", content: source },
                    ...files,
                  ]}
                  readOnly={busy}
                  testId="package-file-input"
                  onChange={(path, content) => {
                    if (path === (format === "apm" ? "apm.yml" : "plugin.json")) setSource(content);
                    else setFiles((current) => replacePackageFile(current, path, content));
                  }}
                />
              </>
            )}
          </fieldset>
          {(error || localError || parsed.error) && (
            <p role="alert" data-testid="package-editor-error" className="text-sm text-destructive">
              {error || localError || parsed.error}
            </p>
          )}
          <div className="sticky bottom-0 border-t border-surface-highest bg-surface pt-3 flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-outline">
              {files.length} files · {selectedSkills.length} skills selected
            </span>
            <Button
              type="submit"
              data-testid="package-submit"
              disabled={busy || !name.trim() || Boolean(parsed.error || mcpError)}
            >
              {pending ? "Saving…" : initial ? "Save changes" : "Save to catalog"}
            </Button>
          </div>
        </form>
      )}
    </DialogContent>
  );
}
