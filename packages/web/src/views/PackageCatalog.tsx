import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { strToU8, zipSync } from "fflate";
import { MoreHorizontal, PackagePlus, Search, Upload } from "lucide-react";
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
import { ResponsiveFilters } from "@/components/ResponsiveFilters";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
  const [deleting, setDeleting] = useState<{ name: string; revision: string }>();
  const deletion = useMutation({
    mutationFn: (pkg: { name: string; revision: string }) =>
      api.agentPackages.delete(pkg.name, pkg.revision),
    onSuccess: async (_, pkg) => {
      setDeleting(undefined);
      if (selectedId === pkg.name) closeDetail();
      forgetPackageDraft(pkg.name);
      setNotice(`${pkg.name} deleted from your catalog.`);
      await refresh();
    },
  });
  async function requestDelete(name: string) {
    setBusy(true);
    setError(undefined);
    deletion.reset();
    try {
      const pkg = (await api.agentPackages.get(name)) as PackageFull & { revision: string };
      if (!pkg.revision)
        throw new Error("Package revision is missing; update the API before deleting");
      setDeleting({ name: pkg.name, revision: pkg.revision });
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not open package deletion.");
    } finally {
      setBusy(false);
    }
  }
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
    <div className="min-w-0 space-y-4">
      <ViewHeader
        title="Packages"
        meta={`${packages.data?.packages.length ?? 0} in your catalog`}
        help="Packages combine instructions, skills and tools for reuse. Use a package in chat or a terminal on the host and folder you choose."
        action={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
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
      {notice && (
        <p role="status" className="text-sm text-primary wrap-break-word">
          {notice}
        </p>
      )}
      {(error || packages.error) && (
        <p role="alert" data-testid="package-error" className="text-sm text-destructive">
          <span data-testid="page-error">{error ?? packages.error?.message}</span>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 lg:max-w-md">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
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
        <ResponsiveFilters activeCount={Number(format !== "all")}>
          <select
            aria-label="Filter package type"
            data-testid="package-format-filter"
            className="form-control form-control-single w-full lg:w-auto"
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
        </ResponsiveFilters>
      </div>
      {packages.isLoading && (
        <p role="status" data-testid="page-loading">
          Loading your catalog…
        </p>
      )}
      <div className="divide-y divide-outline-variant">
        {filtered.map((pkg) => (
          <article
            key={pkg.name}
            data-testid="agent-package-row"
            data-package-name={pkg.name}
            className="flex min-w-0 flex-wrap items-start justify-between gap-x-6 gap-y-2 px-2 py-3 sm:flex-nowrap"
          >
            <div className="min-w-0 flex-1">
              <button
                type="button"
                data-testid="package-inspect"
                onClick={() => openDetail(pkg.name)}
                className="min-h-8 text-left text-sm font-medium wrap-break-word hover:text-primary"
              >
                {pkg.name}
              </button>
              <span className="ml-3 text-xs text-muted-foreground">
                {pkg.format === "apm" ? "APM package" : "Agent Plugins"}
                {pkg.version ? ` · v${pkg.version}` : ""}
              </span>
              {pkg.description && (
                <p className="line-clamp-2 text-sm text-muted-foreground wrap-break-word">
                  {pkg.description}
                </p>
              )}
              {pkg.warnings.map((warning) => (
                <p key={warning} className="mt-2 text-xs text-muted-foreground wrap-break-word">
                  {warning}
                </p>
              ))}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                data-testid="package-run"
                disabled={busy}
                onClick={() => openRun(pkg.name)}
              >
                Use package
              </Button>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    data-testid="package-actions-menu"
                    aria-label={`Actions for ${pkg.name}`}
                  >
                    <MoreHorizontal size={16} />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  aria-label="Package actions"
                  align="end"
                  className="w-44 space-y-1 p-1"
                >
                  <Button
                    size="sm"
                    variant="ghost"
                    className="w-full justify-start"
                    data-testid="package-card-edit"
                    onClick={() => void edit(pkg.name)}
                  >
                    Edit package
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="w-full justify-start text-destructive"
                    data-testid="package-card-delete"
                    disabled={busy || deletion.isPending}
                    onClick={() => void requestDelete(pkg.name)}
                  >
                    Delete package
                  </Button>
                </PopoverContent>
              </Popover>
            </div>
          </article>
        ))}
      </div>
      {!packages.isLoading && !packages.error && !filtered.length && (
        <div data-testid="page-empty" className="px-4 py-16 text-center">
          <p className="text-sm text-muted-foreground">
            {search || format !== "all" ? "No matching packages" : "No packages configured"}
          </p>
        </div>
      )}
      {packages.data?.broken.map((issue) => (
        <p role="alert" key={issue.path} className="text-destructive wrap-break-word">
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
          onDelete={() => void requestDelete(selectedId)}
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
      <Dialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open && !deletion.isPending) setDeleting(undefined);
        }}
      >
        <DialogContent data-testid="package-delete-dialog">
          <DialogHeader>
            <DialogTitle>Delete package?</DialogTitle>
            <DialogDescription>
              Delete {deleting?.name} from your catalog? Copies already installed in project folders
              will remain.
            </DialogDescription>
          </DialogHeader>
          {deletion.error && (
            <p role="alert" data-testid="package-delete-error" className="text-sm text-destructive">
              {deletion.error.message}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              data-testid="package-delete-cancel"
              disabled={deletion.isPending}
              onClick={() => setDeleting(undefined)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              data-testid="package-delete-confirm"
              disabled={deletion.isPending || !deleting}
              onClick={() => {
                if (deleting) deletion.mutate(deleting);
              }}
            >
              {deletion.isPending ? "Deleting…" : "Delete package"}
            </Button>
          </div>
        </DialogContent>
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
