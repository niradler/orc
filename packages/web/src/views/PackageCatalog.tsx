import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { strToU8, zipSync } from "fflate";
import { ArrowRight, FileBox, PackagePlus, Search, Upload } from "lucide-react";
import { useState } from "react";
import { Link, Navigate, useLocation, useParams, useSearchParams } from "react-router-dom";
import {
  type AgentSetup,
  api,
  type PackageFull,
  type SkillFileInput,
  type SkillRefContent,
} from "@/api/client";
import { AgentPackageFiles } from "@/components/AgentPackageFiles";
import { PackageEditor } from "@/components/PackageEditor";
import { PackageImportDialog } from "@/components/PackageImportDialog";
import { PackageRunDialog } from "@/components/PackageRunDialog";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ViewHeader } from "@/components/ViewHeader";
import { useDetailRoute } from "@/hooks/useDetailRoute";
import type { PackageInput } from "@/lib/package-draft";
import Agents from "@/views/Agents";

type Editable = PackageFull & { revision: string; draftFiles: SkillFileInput[] };

function download(filename: string, bytes: Uint8Array) {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/zip" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function LegacyAgentsRedirect() {
  const { agentId } = useParams();
  return (
    <Navigate replace to={`/packages/agents${agentId ? `/${encodeURIComponent(agentId)}` : ""}`} />
  );
}

export default function PackageCatalog() {
  const cache = useQueryClient();
  const { pathname } = useLocation();
  const [params, setParams] = useSearchParams();
  const tab = pathname.startsWith("/packages/agents")
    ? "agents"
    : params.get("tab") === "setups"
      ? "setups"
      : "library";
  const packages = useQuery({ queryKey: ["agent-packages"], queryFn: api.agentPackages.list });
  const setups = useQuery({ queryKey: ["agent-setups"], queryFn: api.agentSetups.list });
  const tools = useQuery({ queryKey: ["package-tools"], queryFn: api.packageTools.list });
  const { selectedId, openDetail, closeDetail } = useDetailRoute("/packages/item", "packageName");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Editable>();
  const [importing, setImporting] = useState(false);
  const [setup, setSetup] = useState<AgentSetup>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const search = params.get("q") ?? "";
  const format = params.get("format") ?? "all";
  async function refresh() {
    await Promise.all(
      ["agent-packages", "agents", "skills", "package-skill-picker", "agent-package"].map((key) =>
        cache.invalidateQueries({ queryKey: [key] }),
      ),
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
      setCreating(false);
      setEditing(undefined);
      setNotice(`${pkg.name} saved to your catalog.`);
      openDetail(pkg.name);
    },
  });
  async function edit(name: string) {
    setBusy(true);
    setError(undefined);
    save.reset();
    try {
      const pkg = (await api.agentPackages.get(name)) as PackageFull & { revision: string };
      const files = await Promise.all(
        pkg.files.map(async (ref) => {
          const file = (await api.agentPackages.get(name, ref.name)) as SkillRefContent;
          return { path: ref.name, content: file.content, encoding: file.encoding };
        }),
      );
      if (!pkg.revision)
        throw new Error("Package revision is missing; update the API before editing");
      closeDetail();
      setEditing({ ...pkg, draftFiles: files });
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
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
        <h2 className="text-xl font-semibold tracking-tight">
          Your agents, ready for the next project
        </h2>
        <p className="max-w-2xl text-sm text-outline">
          Keep the instructions, skills and tools you trust in one place. Save a package once, then
          install it for your coding agent or launch a configured terminal.
        </p>
      </div>
      <nav
        aria-label="Package catalog sections"
        className="flex flex-wrap gap-1 border-b border-surface-highest pb-2"
      >
        <Button asChild variant={tab === "library" ? "default" : "ghost"}>
          <Link
            to="/packages"
            data-testid="packages-library-tab"
            aria-current={tab === "library" ? "page" : undefined}
          >
            Packages
          </Link>
        </Button>
        <Button asChild variant={tab === "agents" ? "default" : "ghost"}>
          <Link
            to="/packages/agents"
            data-testid="nav-agents"
            aria-current={tab === "agents" ? "page" : undefined}
          >
            Agent definitions
          </Link>
        </Button>
        <Button asChild variant={tab === "setups" ? "default" : "ghost"}>
          <Link
            to="/packages?tab=setups"
            data-testid="packages-setups-tab"
            aria-current={tab === "setups" ? "page" : undefined}
          >
            Saved setups{setups.data?.setups.length ? ` (${setups.data.setups.length})` : ""}
          </Link>
        </Button>
      </nav>
      {notice && (
        <p role="status" className="text-sm text-primary break-words">
          {notice}
        </p>
      )}
      {(error || packages.error || setups.error) && (
        <p role="alert" data-testid="package-error" className="text-sm text-destructive">
          {error ?? packages.error?.message ?? setups.error?.message}
        </p>
      )}
      {tab === "agents" ? (
        <Agents embedded />
      ) : tab === "setups" ? (
        <section className="space-y-3">
          <p className="text-sm text-outline">
            Reopen a previous combination of package, coding agent and project. Change the starting
            prompt each time.
          </p>
          {setups.isLoading && <p>Loading setups…</p>}
          {setups.data?.setups.map((saved) => (
            <button
              key={saved.name}
              data-testid="agent-setup-row"
              type="button"
              className="w-full rounded-lg border border-surface-highest p-4 text-left hover:border-primary"
              onClick={() => setSetup(saved)}
            >
              <span className="flex items-center justify-between gap-3">
                <strong className="min-w-0 break-words">{saved.name}</strong>
                <ArrowRight size={18} className="shrink-0" />
              </span>
              <span className="mt-2 block text-sm text-outline break-words">
                {saved.backend} · {saved.packages.join(", ")}
              </span>
              <span className="mt-1 block truncate text-xs text-outline">{saved.cwd}</span>
            </button>
          ))}
          {!setups.isLoading && setups.data?.setups.length === 0 && (
            <div className="rounded-lg border border-dashed border-surface-highest p-8 text-center">
              <h3 className="font-medium">Keep your favorite launches ready</h3>
              <p className="mt-2 text-sm text-outline">
                Open a package, choose Use package, then save the agent and project as a setup.
              </p>
              <Button asChild variant="outline" className="mt-4">
                <Link to="/packages">Browse packages</Link>
              </Button>
            </div>
          )}
          {setups.data?.broken.map((issue) => (
            <p role="alert" key={issue.path} className="text-destructive break-words">
              {issue.path}: {issue.error}
            </p>
          ))}
        </section>
      ) : (
        <>
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="relative min-w-0 flex-1">
              <Search size={16} className="absolute left-3 top-3 text-outline" />
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
              className="rounded border border-surface-highest bg-surface-low p-2 text-sm"
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
          {packages.isLoading && <p>Loading your catalog…</p>}
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {filtered.map((pkg) => (
              <article
                key={pkg.name}
                data-testid="agent-package-row"
                data-package-name={pkg.name}
                className="min-w-0 flex flex-col rounded-lg border border-surface-highest bg-surface-low p-4"
              >
                <span className="mb-3 text-xs text-outline">
                  {pkg.format === "apm" ? "APM package" : "Agent Plugins"}
                  {pkg.version ? ` · v${pkg.version}` : ""}
                </span>
                <button
                  type="button"
                  data-testid="package-inspect"
                  onClick={() => openDetail(pkg.name)}
                  className="text-left font-semibold break-words hover:text-primary"
                >
                  {pkg.name}
                </button>
                <p className="mt-2 flex-1 text-sm text-outline break-words">
                  {pkg.description ||
                    "Add a description to help you choose this configuration later."}
                </p>
                {pkg.warnings.map((warning) => (
                  <p key={warning} className="mt-2 text-xs text-outline break-words">
                    {warning}
                  </p>
                ))}
                <div className="mt-5 grid grid-cols-2 gap-2">
                  <Button
                    data-testid="package-run"
                    disabled={busy}
                    onClick={() => openRun(pkg.name)}
                  >
                    Use package
                  </Button>
                  <Button variant="outline" onClick={() => openDetail(pkg.name)}>
                    View configuration
                  </Button>
                </div>
              </article>
            ))}
          </div>
          {!packages.isLoading && !filtered.length && (
            <div className="rounded-lg border border-dashed border-surface-highest px-4 py-10 text-center">
              <FileBox size={32} className="mx-auto mb-3 text-outline" />
              <h3 className="font-medium">
                {search || format !== "all"
                  ? "No matching configurations"
                  : "Build your personal agent catalog"}
              </h3>
              <p className="mx-auto mt-2 max-w-md text-sm text-outline">
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
            <p className="text-xs text-outline">
              Catalog editing is available. Installation, Git acquisition and installation exports
              require APM on this ORC machine.
            </p>
          )}
        </>
      )}
      {selectedId && (
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
        open={creating || Boolean(editing)}
        onOpenChange={(open) => {
          if (!open && !save.isPending) {
            setCreating(false);
            setEditing(undefined);
          }
        }}
      >
        {(creating || editing) && (
          <PackageEditor
            initial={
              editing
                ? {
                    name: editing.name,
                    content: editing.content,
                    format: editing.format,
                    files: editing.draftFiles,
                  }
                : undefined
            }
            pending={save.isPending}
            error={save.error?.message}
            onSave={(input) => save.mutate(input)}
          />
        )}
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
