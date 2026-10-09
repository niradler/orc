import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { strToU8, zipSync } from "fflate";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { parse as parseYaml } from "yaml";
import { type AgentSetup, api, type PackageFull, type SkillRefContent } from "@/api/client";
import { AgentPackageEditor } from "@/components/AgentPackageEditor";
import { AgentPackageFiles } from "@/components/AgentPackageFiles";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ViewHeader } from "@/components/ViewHeader";
import { readPrimitiveFolder } from "@/lib/primitive-files";
import { useTerminals } from "@/lib/terminals";

export default function Packages() {
  const cache = useQueryClient();
  const navigate = useNavigate();
  const terminals = useTerminals();
  const packages = useQuery({ queryKey: ["agent-packages"], queryFn: api.agentPackages.list });
  const setups = useQuery({ queryKey: ["agent-setups"], queryFn: api.agentSetups.list });
  const agents = useQuery({ queryKey: ["agents"], queryFn: api.agents.list });
  const tools = useQuery({ queryKey: ["package-tools"], queryFn: api.packageTools.list });
  const [selected, setSelected] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [setup, setSetup] = useState<AgentSetup>();
  const [format, setFormat] = useState<"auto" | "apm" | "agent-plugin">("auto");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const components = useQuery({
    queryKey: ["setup-components", setup?.packages],
    enabled: Boolean(setup?.packages.length),
    queryFn: () =>
      Promise.all(
        (setup?.packages ?? []).map((name) => api.agentPackages.get(name) as Promise<PackageFull>),
      ),
  });
  const refresh = async () => {
    await Promise.all(
      ["agent-packages", "agents", "skills"].map((key) =>
        cache.invalidateQueries({ queryKey: [key] }),
      ),
    );
  };
  const create = useMutation({
    mutationFn: api.agentPackages.create,
    onSuccess: async () => {
      await refresh();
      setCreating(false);
    },
  });

  async function importFolder(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError(undefined);
    try {
      const bundle = await readPrimitiveFolder(files);
      const apm = bundle.find((file) => file.path === "apm.yml");
      const plugin = bundle.find((file) => file.path === "plugin.json");
      if (format === "auto" && apm && plugin)
        throw new Error(
          "Both manifests are present. Choose APM or Agent Plugins before importing.",
        );
      const chosen = format === "auto" ? (apm ? "apm" : "agent-plugin") : format;
      const manifest = chosen === "apm" ? apm : plugin;
      if (!manifest || manifest.encoding === "base64")
        throw new Error("Choose a folder with the selected format's manifest.");
      const parsed = chosen === "apm" ? parseYaml(manifest.content) : JSON.parse(manifest.content);
      // APM uses its declared name; the backend validates it against the full manifest.
      const name = parsed?.name ?? files[0].webkitRelativePath.split("/")[0];
      await api.agentPackages.create({
        name,
        content: manifest.content,
        format: chosen,
        files: bundle.filter(
          (file) => file !== manifest && !(chosen === "agent-plugin" && file.path === "apm.yml"),
        ),
      });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function exportPackage(name: string) {
    setBusy(true);
    setError(undefined);
    try {
      const pkg = (await api.agentPackages.get(name)) as PackageFull;
      const archive: Record<string, Uint8Array> = {
        [`${name}/${pkg.manifestFile}`]: strToU8(pkg.content),
      };
      for (const file of pkg.files) {
        const content = (await api.agentPackages.get(name, file.name)) as SkillRefContent;
        archive[`${name}/${file.name}`] =
          content.encoding === "base64"
            ? Uint8Array.from(atob(content.content), (char) => char.charCodeAt(0))
            : strToU8(content.content);
      }
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(zipSync(archive))], { type: "application/zip" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `${name}.zip`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function perform(action: "run" | "save") {
    if (!setup) return;
    setBusy(true);
    setError(undefined);
    try {
      if (action === "save") {
        await api.agentSetups.create(setup);
        await cache.invalidateQueries({ queryKey: ["agent-setups"] });
        setSetup(undefined);
      } else {
        const terminal = await terminals.create({ kind: setup.backend, name: setup.name, setup });
        setSetup(undefined);
        navigate(`/terminals/${terminal.id}`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <ViewHeader
        title="Packages"
        meta={`${packages.data?.packages.length ?? 0} reusable packages`}
        action={
          <Button
            data-testid="new-agent-package-button"
            onClick={() => {
              create.reset();
              setCreating(true);
            }}
          >
            New APM package
          </Button>
        }
      />
      <p className="text-sm text-outline">
        OpenAPM and portable Agent Plugins, shared across your agent setups. Importing preserves
        files without running them.
      </p>
      <div className="border border-surface-highest p-4 space-y-2">
        <Label htmlFor="package-format">Import format</Label>
        <select
          id="package-format"
          data-testid="package-import-format"
          value={format}
          onChange={(event) => setFormat(event.target.value as typeof format)}
          className="bg-surface-low border p-2"
        >
          <option value="auto">Detect from manifest</option>
          <option value="apm">OpenAPM</option>
          <option value="agent-plugin">Agent Plugins</option>
        </select>
        <Label htmlFor="agent-package-folder">Import package folder</Label>
        <Input
          id="agent-package-folder"
          data-testid="agent-package-folder"
          type="file"
          multiple
          {...{ webkitdirectory: "" }}
          disabled={busy}
          onChange={(event) => void importFolder(event.target.files)}
        />
      </div>
      {(error || packages.error || setups.error || tools.error) && (
        <p role="alert" data-testid="package-error" className="text-destructive">
          {error ?? packages.error?.message ?? setups.error?.message ?? tools.error?.message}
        </p>
      )}
      {packages.isLoading && <p>Loading packages...</p>}
      {(packages.data?.broken ?? []).map((issue) => (
        <p role="alert" key={issue.path}>
          {issue.path}: {issue.error}
        </p>
      ))}
      {packages.data?.packages.map((pkg) => (
        <div
          key={pkg.name}
          data-testid="agent-package-row"
          data-package-name={pkg.name}
          className="border border-surface-highest p-4 space-y-2"
        >
          <button
            type="button"
            data-testid="package-inspect"
            onClick={() => setSelected(pkg.name)}
            className="font-medium"
          >
            {pkg.name}
            {pkg.version ? `@${pkg.version}` : ""}
          </button>
          <p className="text-xs text-outline">
            {pkg.format === "apm" ? "OpenAPM" : "Agent Plugins"} · {pkg.description}
          </p>
          {pkg.warnings.map((warning) => (
            <p className="text-xs" key={warning}>
              {warning}
            </p>
          ))}
          <div className="flex gap-2">
            <Button
              variant="outline"
              data-testid="package-export"
              disabled={busy}
              onClick={() => void exportPackage(pkg.name)}
            >
              Export package
            </Button>
            <Button
              data-testid="package-run"
              onClick={() => {
                setError(undefined);
                setSetup({
                  name: `${pkg.name.replace(/\./g, "-")}-setup`,
                  packages: [pkg.name],
                  backend: pkg.format === "agent-plugin" ? "copilot" : "claude",
                  tool: "apm",
                  cwd: "",
                  prompt: "",
                });
              }}
            >
              Run with…
            </Button>
          </div>
        </div>
      ))}
      {!packages.isLoading && packages.data?.packages.length === 0 && (
        <p>Import a package to make its components reusable.</p>
      )}
      {selected && (
        <AgentPackageFiles key={selected} name={selected} onClose={() => setSelected(undefined)} />
      )}
      <div className="space-y-2">
        <h2 className="font-medium">Saved agent setups</h2>
        {setups.data?.setups.map((saved) => (
          <button
            type="button"
            data-testid="agent-setup-row"
            key={saved.name}
            className="block border p-3"
            onClick={() => {
              setError(undefined);
              setSetup(saved);
            }}
          >
            {saved.name} · {saved.backend} · {saved.packages.join(", ")}
          </button>
        ))}
        {(setups.data?.broken ?? []).map((issue) => (
          <p role="alert" key={issue.path}>
            {issue.path}: {issue.error}
          </p>
        ))}
      </div>
      <Dialog open={creating} onOpenChange={(open) => !create.isPending && setCreating(open)}>
        {creating && (
          <AgentPackageEditor
            pending={create.isPending}
            error={create.error?.message}
            onSave={(input) => create.mutate(input)}
          />
        )}
      </Dialog>
      <Dialog open={Boolean(setup)} onOpenChange={(open) => !open && !busy && setSetup(undefined)}>
        {setup && (
          <DialogContent className="max-h-[90vh] overflow-auto">
            <DialogHeader>
              <DialogTitle>Run with…</DialogTitle>
              <DialogDescription>Select an agent and project for these packages.</DialogDescription>
            </DialogHeader>
            <Label htmlFor="setup-name">Setup name</Label>
            <Input
              id="setup-name"
              data-testid="setup-name"
              value={setup.name}
              onChange={(e) => setSetup({ ...setup, name: e.target.value })}
            />
            <Label htmlFor="setup-backend">Coding agent</Label>
            <select
              id="setup-backend"
              data-testid="setup-backend"
              className="bg-surface-low border p-2"
              value={setup.backend}
              onChange={(e) =>
                setSetup({ ...setup, backend: e.target.value as AgentSetup["backend"] })
              }
            >
              {["claude", "codex", "copilot"].map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                  {terminals.info?.launchers.includes(kind as AgentSetup["backend"])
                    ? ""
                    : " (not available)"}
                </option>
              ))}
            </select>
            <Label htmlFor="setup-tool">Package tooling</Label>
            <select
              id="setup-tool"
              data-testid="setup-tool"
              className="bg-surface-low border p-2"
              value={setup.tool}
              onChange={(e) => setSetup({ ...setup, tool: e.target.value as AgentSetup["tool"] })}
            >
              <option value="apm">APM {tools.data?.apm ? "" : "(not installed)"}</option>
              <option value="skills">Vercel skills (skills-only plugins)</option>
            </select>
            {!tools.data?.apm && setup.tool === "apm" && (
              <p>
                Install apm-cli 0.33.0 or newer on the API machine. ORC_APM_PATH can point to its
                executable.
              </p>
            )}
            <Label htmlFor="setup-cwd">Project folder on the API machine</Label>
            <Input
              id="setup-cwd"
              data-testid="setup-cwd"
              value={setup.cwd}
              onChange={(e) => setSetup({ ...setup, cwd: e.target.value })}
            />
            <Button
              variant="outline"
              disabled={busy || !terminals.info?.ready}
              onClick={async () => {
                try {
                  const result = await api.terminals.pickFolder(setup.cwd || undefined);
                  if (result.path) setSetup({ ...setup, cwd: result.path });
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Browse
            </Button>
            <Label htmlFor="setup-agent">Specialist profile (Claude)</Label>
            <select
              id="setup-agent"
              data-testid="setup-agent"
              className="bg-surface-low border p-2"
              value={setup.agent ?? ""}
              onChange={(e) => setSetup({ ...setup, agent: e.target.value || undefined })}
            >
              <option value="">Backend default</option>
              {agents.data?.agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
            <Label htmlFor="setup-model">Model (optional)</Label>
            <Input
              id="setup-model"
              data-testid="setup-model"
              value={setup.model ?? ""}
              onChange={(e) => setSetup({ ...setup, model: e.target.value || undefined })}
            />
            <Label htmlFor="setup-prompt">Starting prompt (optional)</Label>
            <Input
              id="setup-prompt"
              data-testid="setup-prompt"
              value={setup.prompt}
              onChange={(e) => setSetup({ ...setup, prompt: e.target.value })}
            />
            <fieldset>
              <legend>Packages</legend>
              {packages.data?.packages.map((pkg) => (
                <label key={pkg.name} className="block text-sm">
                  <input
                    type="checkbox"
                    data-testid="setup-package"
                    checked={setup.packages.includes(pkg.name)}
                    onChange={(e) =>
                      setSetup({
                        ...setup,
                        packages: e.target.checked
                          ? [...setup.packages, pkg.name]
                          : setup.packages.filter((name) => name !== pkg.name),
                      })
                    }
                  />{" "}
                  {pkg.name} ({pkg.format})
                </label>
              ))}
            </fieldset>
            <div data-testid="setup-components" className="text-sm space-y-1">
              <p className="font-medium">Selected configuration</p>
              {components.data?.map((pkg) => (
                <p key={pkg.name}>
                  {pkg.name}:{" "}
                  {
                    pkg.files.filter((file) =>
                      /^(skills|\.apm\/skills)\/[^/]+\/SKILL\.md$/.test(file.name),
                    ).length
                  }{" "}
                  skill files
                  {pkg.files.some((file) => file.name === "mcp.json")
                    ? ", native MCP configuration"
                    : ""}
                </p>
              ))}
              {setup.agent && (
                <p>Profile instructions, model and allowed tools apply through Claude.</p>
              )}
              {components.error && <p role="alert">{components.error.message}</p>}
            </div>
            <p className="text-sm text-outline">
              Deploys selected packages into this project. APM adds dependencies to apm.yml and may
              reformat it, retaining existing configuration. Configuration remains after the
              session. Trust and file-conflict prompts appear in the terminal. APM portable plugins
              currently activate natively for Copilot; Vercel skills supports skills-only packages.
            </p>
            {!terminals.info?.ready && (
              <p role="alert">{terminals.info?.reason ?? "Checking terminal availability…"}</p>
            )}
            {error && (
              <p role="alert" data-testid="setup-error">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <Button
                variant="outline"
                data-testid="setup-save"
                disabled={busy || !setup.cwd || !setup.packages.length}
                onClick={() => void perform("save")}
              >
                Save agent setup
              </Button>
              <Button
                data-testid="setup-launch"
                disabled={busy || !setup.cwd || !setup.packages.length || !terminals.info?.ready}
                onClick={() => void perform("run")}
              >
                {busy ? "Preparing…" : "Open in ORC terminal"}
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
