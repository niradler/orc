import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { type AgentSetup, api, type PackageFull } from "@/api/client";
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
import { Textarea } from "@/components/ui/textarea";
import { useTerminals } from "@/lib/terminals";

export function PackageRunDialog({
  initial,
  onClose,
}: {
  initial: AgentSetup;
  onClose: () => void;
}) {
  const [setup, setSetup] = useState<AgentSetup>({ ...initial, tool: "apm" });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [commandMode, setCommandMode] = useState<"run" | "install">("run");
  const commandBox = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const cache = useQueryClient();
  const terminals = useTerminals();
  const packages = useQuery({ queryKey: ["agent-packages"], queryFn: api.agentPackages.list });
  const agents = useQuery({ queryKey: ["agents"], queryFn: api.agents.list });
  const tools = useQuery({ queryKey: ["package-tools"], queryFn: api.packageTools.list });
  const components = useQuery({
    queryKey: ["setup-components", setup.packages],
    enabled: setup.packages.length > 0,
    queryFn: () =>
      Promise.all(
        setup.packages.map((name) => api.agentPackages.get(name) as Promise<PackageFull>),
      ),
  });
  const command = useMutation({ mutationFn: api.agentSetups.command });
  useEffect(() => {
    if (command.data) commandBox.current?.scrollIntoView({ block: "nearest" });
  }, [command.data]);
  const portable = components.data?.some((pkg) => pkg.format === "agent-plugin");
  const unsupported = portable && setup.backend !== "copilot";
  const valid = Boolean(setup.cwd.trim() && setup.packages.length && setup.name.trim());
  const canOperate =
    valid && tools.data?.apm && !unsupported && !components.error && !components.isFetching;
  function change(next: Partial<AgentSetup>) {
    setSetup((current) => ({ ...current, ...next }));
    command.reset();
    setCopied(false);
    setError(undefined);
  }
  async function perform(operation: "save" | "run" | "install") {
    setBusy(true);
    setError(undefined);
    try {
      if (operation === "save") {
        await api.agentSetups.create({ ...setup, operation: "run" });
        await cache.invalidateQueries({ queryKey: ["agent-setups"] });
        onClose();
      } else {
        const terminal = await terminals.create({
          kind: setup.backend,
          name: `${setup.name}${operation === "install" ? " · install" : ""}`,
          setup: { ...setup, operation },
        });
        onClose();
        navigate(`/terminals/${terminal.id}`);
      }
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && !command.isPending && onClose()}>
      <DialogContent className="w-[calc(100%_-_1rem)] max-w-2xl max-h-[94dvh] overflow-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>Use this configuration</DialogTitle>
          <DialogDescription>
            Install it for your coding agent, launch here, or copy a command for your own terminal.
          </DialogDescription>
        </DialogHeader>
        <fieldset disabled={busy || command.isPending} className="min-w-0 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="setup-backend">Coding agent</Label>
              <select
                id="setup-backend"
                data-testid="setup-backend"
                className="w-full rounded border border-surface-highest bg-surface-low p-3"
                value={setup.backend}
                onChange={(event) =>
                  change({ backend: event.target.value as AgentSetup["backend"], agent: undefined })
                }
              >
                {["claude", "codex", "copilot"].map((kind) => (
                  <option
                    key={kind}
                    value={kind}
                    disabled={Boolean(portable && kind !== "copilot")}
                  >
                    {kind}
                    {portable && kind !== "copilot"
                      ? " · unsupported for this plugin"
                      : !terminals.info?.launchers.includes(kind as AgentSetup["backend"])
                        ? " · not installed"
                        : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="setup-name">Setup name</Label>
              <Input
                id="setup-name"
                data-testid="setup-name"
                value={setup.name}
                onChange={(event) => change({ name: event.target.value })}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="setup-cwd">Project folder on this ORC machine</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="setup-cwd"
                data-testid="setup-cwd"
                value={setup.cwd}
                onChange={(event) => change({ cwd: event.target.value })}
              />
              <Button
                type="button"
                variant="outline"
                disabled={!terminals.info?.ready}
                onClick={async () => {
                  try {
                    const result = await api.terminals.pickFolder(setup.cwd || undefined);
                    if (result.path) change({ cwd: result.path });
                  } catch (failure) {
                    setError((failure as Error).message);
                  }
                }}
              >
                Browse
              </Button>
            </div>
          </div>
          {setup.backend === "claude" && (
            <div className="space-y-1">
              <Label htmlFor="setup-agent">Agent profile (optional)</Label>
              <select
                id="setup-agent"
                data-testid="setup-agent"
                className="w-full rounded border border-surface-highest bg-surface-low p-3"
                value={setup.agent ?? ""}
                onChange={(event) => change({ agent: event.target.value || undefined })}
              >
                <option value="">Use package configuration</option>
                {agents.data?.agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="setup-model">Model (optional)</Label>
              <Input
                id="setup-model"
                data-testid="setup-model"
                value={setup.model ?? ""}
                onChange={(event) => change({ model: event.target.value || undefined })}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="setup-prompt">What should the agent work on?</Label>
            <Textarea
              id="setup-prompt"
              data-testid="setup-prompt"
              rows={3}
              value={setup.prompt}
              onChange={(event) => change({ prompt: event.target.value })}
            />
          </div>
          <details>
            <summary className="cursor-pointer py-2 text-sm">Combine with more packages</summary>
            <div className="space-y-2 pt-2">
              {packages.data?.packages.map((pkg) => (
                <label
                  key={pkg.name}
                  className="flex items-center gap-3 rounded border border-surface-highest p-3 text-sm"
                >
                  <input
                    type="checkbox"
                    className="size-5"
                    data-testid="setup-package"
                    checked={setup.packages.includes(pkg.name)}
                    onChange={(event) =>
                      change({
                        packages: event.target.checked
                          ? [...setup.packages, pkg.name]
                          : setup.packages.filter((name) => name !== pkg.name),
                      })
                    }
                  />
                  <span className="min-w-0 break-words">
                    {pkg.name} · {pkg.format === "apm" ? "APM" : "Agent Plugin"}
                  </span>
                </label>
              ))}
            </div>
          </details>
          <div
            data-testid="setup-components"
            className="rounded-lg bg-surface-low p-3 text-sm space-y-1"
          >
            <p className="font-medium">Configuration to apply</p>
            {components.isFetching && <p>Checking package contents…</p>}
            {components.data?.map((pkg) => (
              <p key={pkg.name} className="break-words">
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
                {pkg.files.some((file) => file.name.endsWith(".instructions.md"))
                  ? ", shared instructions"
                  : ""}
              </p>
            ))}
          </div>
        </fieldset>
        <p className="text-xs text-outline">
          APM installs into this project and retains the configuration after the session. Trust and
          file-conflict prompts appear in the terminal. Copied commands run on this ORC machine in{" "}
          {navigator.platform.startsWith("Win") ? "PowerShell" : "your shell"}.
        </p>
        {unsupported && (
          <p role="alert" className="text-sm text-destructive">
            APM currently activates whole Agent Plugins for Copilot. Select Copilot for this
            package.
          </p>
        )}
        {tools.data && !tools.data.apm && (
          <p role="alert" className="text-sm">
            Install APM 0.33.0 or newer on the ORC machine, or set ORC_APM_PATH.
          </p>
        )}
        {!terminals.info?.ready && (
          <p role="alert" className="text-sm">
            {terminals.info?.reason ?? "Checking terminal availability…"}
          </p>
        )}
        {(error || command.error || components.error) && (
          <p role="alert" data-testid="setup-error" className="text-sm text-destructive">
            {error ?? command.error?.message ?? components.error?.message}
          </p>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          <Button
            data-testid="setup-install"
            variant="outline"
            disabled={busy || !canOperate || !terminals.info?.ready}
            onClick={() => void perform("install")}
          >
            Install for coding agent
          </Button>
          <Button
            data-testid="setup-launch"
            disabled={busy || !canOperate || !terminals.info?.ready}
            onClick={() => void perform("run")}
          >
            {busy ? "Preparing…" : "Run in ORC terminal"}
          </Button>
          <Button
            data-testid="setup-save"
            variant="outline"
            disabled={busy || !valid}
            onClick={() => void perform("save")}
          >
            Save agent setup
          </Button>
          <Button
            data-testid="setup-command"
            variant="outline"
            disabled={busy || command.isPending || !canOperate}
            onClick={() => command.mutate({ ...setup, operation: commandMode })}
          >
            {command.isPending ? "Preparing command…" : "Command for my terminal"}
          </Button>
        </div>
        <div className="space-y-1">
          <Label htmlFor="command-mode">Command for your terminal</Label>
          <select
            id="command-mode"
            className="w-full rounded border border-surface-highest bg-surface-low p-3 text-sm"
            disabled={busy || command.isPending}
            value={commandMode}
            onChange={(event) => {
              setCommandMode(event.target.value as "run" | "install");
              command.reset();
            }}
          >
            <option value="run">Install and launch the agent</option>
            <option value="install">Install configuration only</option>
          </select>
        </div>
        {command.data && (
          <div
            ref={commandBox}
            className="min-w-0 space-y-2 rounded border border-surface-highest p-3"
          >
            <Label htmlFor="package-command">Run in {command.data.shell} on the ORC machine</Label>
            <Textarea
              id="package-command"
              data-testid="package-command"
              value={command.data.command}
              readOnly
              rows={3}
              className="font-mono text-xs"
            />
            <Button
              variant="outline"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(command.data.command);
                  setCopied(true);
                } catch {
                  setError(
                    "Copy is unavailable in this browser. Select and copy the command above.",
                  );
                }
              }}
            >
              {copied ? "Copied" : "Copy command"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
