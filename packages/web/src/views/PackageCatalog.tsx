import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { strToU8, zipSync } from "fflate";
import { FileBox, PackagePlus, Search, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  type AgentSetup,
  api,
  type PackageFull,
  type SkillFileInput,
  type SkillRefContent,
} from "@/api/client";
import { AgentPackageFiles } from "@/components/AgentPackageFiles";
import {
  confirmPackageDraftClose,
  forgetPackageDraft,
  getPackageDraftBase,
  PackageEditor,
} from "@/components/PackageEditor";
import { PackageImportDialog } from "@/components/PackageImportDialog";
import { PackageRunDialog } from "@/components/PackageRunDialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ViewHeader } from "@/components/ViewHeader";
import { useDetailRoute } from "@/hooks/useDetailRoute";
import type { PackageInput } from "@/lib/package-draft";
import { saveFile } from "@/lib/save-file";
import { useViewParam } from "@/lib/view-params";

type Editable = PackageFull & { revision: string; draftFiles: SkillFileInput[] };

function download(filename: string, bytes: Uint8Array) {
  saveFile(new Blob([new Uint8Array(bytes)], { type: "application/zip" }), filename);
}

export function LegacyAgentsRedirect() {
  const { agentId } = useParams();
  return (
    <Navigate replace to={`/packages/agents${agentId ? `/${encodeURIComponent(agentId)}` : ""}`} />
  );
}

export default function PackageCatalog() {
  const cache = useQueryClient();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [action, setAction] = useViewParam<string>("packageAction", "", [
    "",
    "new",
    "import",
    "edit",
  ]);
  const packages = useQuery({ queryKey: ["agent-packages"], queryFn: api.agentPackages.list });
  const tools = useQuery({ queryKey: ["package-tools"], queryFn: () => api.packageTools.list() });
  const { selectedId, closeDetail } = useDetailRoute("/packages/item", "packageName");
  const creating = action === "new";
  const setCreating = (open: boolean) => setAction(open ? "new" : "");
  const [editing, setEditing] = useState<Editable>();
  const importing = action === "import";
  const setImporting = (open: boolean) => setAction(open ? "import" : "");
  function openDetail(name: string) {
    const next = new URLSearchParams(window.location.search);
    next.delete("packageAction");
    navigate(`/packages/item/${encodeURIComponent(name)}?${next}`);
  }
  function edit(name: string) {
    const next = new URLSearchParams(window.location.search);
    next.set("packageAction", "edit");
    navigate(`/packages/item/${encodeURIComponent(name)}?${next}`);
  }
  const [setup, setSetup] = useState<AgentSetup>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const search = params.get("q") ?? "";
  const format = params.get("format") ?? "all";
  async function refresh() {
    await Promise.all(
      [
        "agent-packages",
        "agents",
        "skills",
        "package-skill-picker",
        "agent-package",
        "agent-package-files",
      ].map((key) => cache.invalidateQueries({ queryKey: [key] })),
    );
  }
  const save = useMutation({
    mutationFn: (input: PackageInput) =>
      editing
        ? api.agentPackages.update(editing.name, {
            content: input.content,
            files: input.files,
            skills: input.skills,
            expectedRevision: editing.revision,
          })
        : api.agentPackages.create(input),
    onSuccess: async (pkg) => {
      await refresh();
      forgetPackageDraft(editing?.name ?? "new");
      setCreating(false);
      setEditing(undefined);
      setNotice(`${pkg.name} saved to your catalog.`);
      openDetail(pkg.name);
    },
  });
  const resetSave = save.reset;
  useEffect(() => {
    let active = true;
    setEditing(undefined);
    if (action !== "edit" || !selectedId) {
      setBusy(false);
      return;
    }
    setBusy(true);
    setError(undefined);
    resetSave();
    void (async () => {
      try {
        const pkg = (await api.agentPackages.get(selectedId)) as PackageFull & { revision: string };
        const files = await Promise.all(
          pkg.files.map(async (ref) => {
            const file = (await api.agentPackages.get(selectedId, ref.name)) as SkillRefContent;
            return { path: ref.name, content: file.content, encoding: file.encoding };
          }),
        );
        if (!pkg.revision)
          throw new Error("Package revision is missing; update the API before editing");
        const baseline = getPackageDraftBase(selectedId);
        if (active)
          setEditing(
            baseline
              ? {
                  ...pkg,
                  content: baseline.content,
                  format: baseline.format,
                  revision: baseline.revision ?? pkg.revision,
                  draftFiles: baseline.files,
                }
              : { ...pkg, draftFiles: files },
          );
      } catch (failure) {
        if (active) setError((failure as Error).message);
      } finally {
        if (active) setBusy(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [action, selectedId, resetSave]);
  function openRun(name: string) {
    const pkg = packages.data?.packages.find((pkg) => pkg.name === name);
    closeDetail();
    setSetup({
      name: `${name.replace(/\./g, "-")}-setup`,
      packages: [name],
      backend: pkg?.format === "agent-plugin" ? "copilot" : "claude",
      tool: "apm",
      cwd: "",
      prompt: "",
    });
  }
  async function exportSource(name: string) {
    setBusy(true);
    setError(undefined);
    try {
      const pkg = (await api.agentPackages.get(name)) as PackageFull;
      const archive: Record<string, Uint8Array> = {
        [`${name}/${pkg.manifestFile}`]: strToU8(pkg.content),
      };
      for (const ref of pkg.files) {
        const file = (await api.agentPackages.get(name, ref.name)) as SkillRefContent;
        archive[`${name}/${ref.name}`] =
          file.encoding === "base64"
            ? Uint8Array.from(atob(file.content), (value) => value.charCodeAt(0))
            : strToU8(file.content);
      }
      download(`${name}-source.zip`, zipSync(archive));
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function exportArtifact(name: string) {
    setBusy(true);
    setError(undefined);
    setNotice("APM is building the installation archive…");
    try {
      const result = await api.agentPackages.exportArtifact(name);
      download(
        result.filename,
        Uint8Array.from(atob(result.content), (value) => value.charCodeAt(0)),
      );
      setNotice(`Exported ${result.format} installation archive.`);
    } catch (failure) {
      setError((failure as Error).message);
      setNotice(undefined);
    } finally {
      setBusy(false);
    }
  }
  const filtered =
    packages.data?.packages.filter(
      (pkg) =>
        `${pkg.name} ${pkg.description}`.toLowerCase().includes(search.toLowerCase()) &&
        (format === "all" || pkg.format === format),
    ) ?? [];
  return (
    <div className="min-w-0 space-y-5">
      <ViewHeader
        title="Packages"
        meta={`${packages.data?.packages.length ?? 0} in your catalog`}
        action={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              data-testid="package-import-button"
              onClick={() => setImporting(true)}
            >
              <Upload size={16} className="mr-2" />
              Import
            </Button>
            <Button
              data-testid="new-agent-package-button"
              onClick={() => {
                save.reset();
                setCreating(true);
              }}
            >
              <PackagePlus size={16} className="mr-2" />
              New package
            </Button>
          </div>
        }
      />
      <div className="space-y-1">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Keep the instructions, skills and tools you trust in one place. Save a package once, then
          launch it in chat or a terminal on the host and folder you choose.
        </p>
      </div>
      {notice && (
        <p role="status" className="text-sm text-primary break-words">
          {notice}
        </p>
      )}
      {(error || packages.error) && (
        <p role="alert" data-testid="package-error" className="text-sm text-destructive">
          <span data-testid="page-error">{error ?? packages.error?.message}</span>
        </p>
      )}
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative min-w-0 flex-1">
          <Search size={16} className="absolute left-3 top-3 text-muted-foreground" />
          <Input
            className="pl-9"
            data-testid="package-search"
            aria-label="Search packages"
            placeholder="Find a configuration by name or purpose…"
            value={search}
            onChange={(event) => {
              const next = new URLSearchParams(params);
              if (event.target.value) next.set("q", event.target.value);
              else next.delete("q");
              setParams(next, { replace: true });
            }}
          />
        </div>
        <select
          aria-label="Filter package type"
          data-testid="package-format-filter"
          className="rounded border border-control-border bg-background p-2 text-sm"
          value={format}
          onChange={(event) => {
            const next = new URLSearchParams(params);
            next.set("format", event.target.value);
            setParams(next, { replace: true });
          }}
        >
          <option value="all">All formats</option>
          <option value="apm">APM packages</option>
          <option value="agent-plugin">Agent Plugins</option>
        </select>
      </div>
      {packages.isLoading && (
        <p role="status" data-testid="page-loading">
          Loading your catalog…
        </p>
      )}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {filtered.map((pkg) => (
          <article
            key={pkg.name}
            data-testid="agent-package-row"
            data-package-name={pkg.name}
            className="min-w-0 flex flex-col border-b border-outline-variant p-4"
          >
            <span className="mb-3 text-xs text-muted-foreground">
              {pkg.format === "apm" ? "APM package" : "Agent Plugins"}
              {pkg.version ? ` · v${pkg.version}` : ""}
            </span>
            <button
              type="button"
              data-testid="package-inspect"
              onClick={() => openDetail(pkg.name)}
              className="text-left font-medium break-words hover:text-primary"
            >
              {pkg.name}
            </button>
            <p className="mt-2 flex-1 text-sm text-muted-foreground break-words">
              {pkg.description || "Add a description to help you choose this configuration later."}
            </p>
            {pkg.warnings.map((warning) => (
              <p key={warning} className="mt-2 text-xs text-muted-foreground break-words">
                {warning}
              </p>
            ))}
            <div className="mt-4 flex flex-wrap items-center gap-1">
              <Button
                size="sm"
                variant="outline"
                data-testid="package-run"
                disabled={busy}
                onClick={() => openRun(pkg.name)}
              >
                Use package
              </Button>
              <Button
                size="sm"
                variant="ghost"
                data-testid="package-card-edit"
                onClick={() => void edit(pkg.name)}
              >
                Edit package
              </Button>
            </div>
          </article>
        ))}
      </div>
      {!packages.isLoading && !packages.error && !filtered.length && (
        <div
          data-testid="page-empty"
          className="rounded-lg border border-dashed border-outline-variant px-4 py-10 text-center"
        >
          <FileBox size={32} className="mx-auto mb-3 text-muted-foreground" />
          <h3 className="font-medium">
            {search || format !== "all"
              ? "No matching configurations"
              : "Build your personal agent catalog"}
          </h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            {search || format !== "all"
              ? "Try another search or package format."
              : "Create an APM package with your instructions and existing skills, or import an Agent Plugin from GitHub."}
          </p>
          {!search && format === "all" && (
            <Button
              className="mt-4"
              onClick={() => {
                save.reset();
                setCreating(true);
              }}
            >
              Create your first package
            </Button>
          )}
        </div>
      )}
      {packages.data?.broken.map((issue) => (
        <p role="alert" key={issue.path} className="text-destructive break-words">
          {issue.path}: {issue.error}
        </p>
      ))}
      {tools.data && !tools.data.apm && (
        <p className="text-xs text-muted-foreground">
          Catalog editing is available. Installation, Git acquisition and installation exports
          require APM on this ORC machine.
        </p>
      )}
      {selectedId && !action && (
        <AgentPackageFiles
          key={selectedId}
          name={selectedId}
          onClose={closeDetail}
          onUse={() => openRun(selectedId)}
          onEdit={() => void edit(selectedId)}
          onExport={() => void exportArtifact(selectedId)}
          onSource={() => void exportSource(selectedId)}
          busy={busy}
          operationError={error}
        />
      )}
      <Dialog
        open={creating || action === "edit"}
        onOpenChange={(open) => {
          if (!open && !save.isPending) {
            if (!confirmPackageDraftClose(editing?.name ?? "new")) return;
            setCreating(false);
            setEditing(undefined);
          }
        }}
      >
        {creating || (action === "edit" && editing) ? (
          <PackageEditor
            initial={
              editing
                ? {
                    name: editing.name,
                    content: editing.content,
                    format: editing.format,
                    files: editing.draftFiles,
                    revision: editing.revision,
                  }
                : undefined
            }
            pending={save.isPending}
            error={save.error?.message}
            onSave={(input) => save.mutate(input)}
          />
        ) : action === "edit" ? (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Package editor</DialogTitle>
            </DialogHeader>
            <p role={error ? "alert" : "status"}>{error ?? "Opening package editor…"}</p>
          </DialogContent>
        ) : null}
      </Dialog>
      {importing && (
        <PackageImportDialog
          onClose={() => setImporting(false)}
          onImported={(name) => {
            void refresh();
            setImporting(false);
            setNotice(`${name} added to your catalog.`);
            openDetail(name);
          }}
        />
      )}
      {setup && (
        <PackageRunDialog key={setup.name} initial={setup} onClose={() => setSetup(undefined)} />
      )}
    </div>
  );
}
