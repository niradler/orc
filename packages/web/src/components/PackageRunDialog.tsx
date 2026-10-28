import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { type AgentSetup, api, type PackageFull } from "@/api/client";
import { RemoteFolderBrowser } from "@/components/terminals/RemoteFolderBrowser";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useChat } from "@/hooks/useChat";
import { useProjects } from "@/hooks/useProjects";
import { useSsh } from "@/hooks/useSsh";
import { useTerminals } from "@/lib/terminals";
import { workspaceDestination } from "@/lib/workspace-navigation";

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
  const location = useLocation();
  const terminals = useTerminals();
  const ssh = useSsh();
  const projects = useProjects();
  const chat = useChat();
  const host = setup.host === undefined ? (ssh.data?.host ?? null) : setup.host;
  const [destination, setDestination] = useState<"terminal" | "chat">("terminal");
  const [browsing, setBrowsing] = useState(false);
  const tools = useQuery({
    queryKey: ["package-tools", host],
    queryFn: () => api.packageTools.list(host),
    enabled: Boolean(ssh.data),
  });
  const hostInfo = useQuery({
    queryKey: ["package-launch-host", host],
    queryFn: () => api.terminals.list(host),
    enabled: Boolean(ssh.data),
    retry: false,
  });
  const components = useQuery({
    queryKey: ["setup-components", setup.packages],
    enabled: setup.packages.length > 0,
    queryFn: () =>
      Promise.all(
        setup.packages.map((name) => api.agentPackages.get(name) as Promise<PackageFull>),
      ),
  });
  const profile = useQuery({
    queryKey: ["agent", setup.agent],
    queryFn: () => api.agents.get(setup.agent as string),
    enabled: Boolean(setup.agent),
  });
  const command = useMutation({ mutationFn: api.agentSetups.command });
  useEffect(() => {
    if (command.data) commandBox.current?.scrollIntoView({ block: "nearest" });
  }, [command.data]);
  const portable = components.data?.some((pkg) => pkg.format === "agent-plugin");
  const unsupported = portable && setup.backend === "claude";
  const needsApm = components.data?.some(
    (pkg) => pkg.format === "apm" || setup.backend !== "codex",
  );
  const valid = Boolean(
    setup.cwd.trim() && (setup.packages.length || setup.agent) && setup.name.trim(),
  );
  const canOperate =
    valid &&
    tools.data?.bun &&
    (!needsApm || tools.data?.apm) &&
    !unsupported &&
    !components.error &&
    !components.isFetching &&
    !profile.error &&
    !profile.isFetching &&
    !hostInfo.isFetching &&
    !hostInfo.error;
  function change(next: Partial<AgentSetup>) {
    setSetup((current) => ({ ...current, ...next }));
    command.reset();
    setCopied(false);
    setError(undefined);
    setBrowsing(false);
  }
  async function perform(operation: "run" | "install") {
    setBusy(true);
    setError(undefined);
    try {
      if (operation === "run" && destination === "chat") {
        const thread = await api.chat.fromSetup({ ...setup, host });
        chat.openThread(thread, { follow: false });
        if (setup.prompt.trim()) void chat.send(setup.prompt);
        const next = new URLSearchParams(location.search);
        next.set("chat", "open");
        next.set("chatThread", thread.id);
        onClose();
        navigate(`${location.pathname}?${next}`);
        return;
      }
      const terminal = await terminals.create({
        kind: setup.backend,
        name: `${setup.name}${operation === "install" ? " · install" : ""}`,
        host,
        setup: { ...setup, host, operation },
      });
      onClose();
      navigate(
        workspaceDestination(
          `/terminals/${terminal.id}`,
          new URLSearchParams(location.search).get("project") ?? "all",
          location.search,
        ),
      );
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && !command.isPending && onClose()}>
      <DialogContent
        closeDisabled={busy || command.isPending}
        className="flex min-w-0 w-[min(960px,calc(100vw-2rem))] max-w-none max-h-[calc(var(--app-height,100dvh)-2rem)] flex-col gap-0 overflow-hidden p-0"
      >
        <DialogHeader className="shrink-0 border-b px-4 py-4 pr-12 sm:px-6">
          <DialogTitle>{setup.packages.length ? "Use package" : "Launch agent"}</DialogTitle>
          <DialogDescription>
            Install it for your coding agent, launch here, or copy a command for your own terminal.
          </DialogDescription>
        </DialogHeader>
        <div
          data-testid="package-setup-body"
          className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6"
        >
          <fieldset disabled={busy || command.isPending} className="min-w-0 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="setup-host">Host</Label>
                <select
                  id="setup-host"
                  data-testid="setup-host"
                  className="form-control form-control-single"
                  value={host ?? ""}
                  onChange={(event) => change({ host: event.target.value || null, cwd: "" })}
                >
                  <option value="">Local</option>
                  {[
                    ...new Set([
                      ...(ssh.data?.hosts ?? []),
                      ...(ssh.data?.host ? [ssh.data.host] : []),
                    ]),
                  ].map((alias) => (
                    <option key={alias} value={alias}>
                      {alias}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="setup-backend">Coding agent</Label>
                <select
                  id="setup-backend"
                  data-testid="setup-backend"
                  className="form-control form-control-single"
                  value={setup.backend}
                  onChange={(event) =>
                    change({ backend: event.target.value as AgentSetup["backend"] })
                  }
                >
                  {["claude", "codex", "copilot"].map((kind) => (
                    <option
                      key={kind}
                      value={kind}
                      disabled={Boolean(portable && kind === "claude")}
                    >
                      {kind}
                      {portable && kind === "claude"
                        ? " · unsupported for this plugin"
                        : !hostInfo.data?.launchers.includes(kind as AgentSetup["backend"])
                          ? " · not installed"
                          : ""}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="space-y-1 sm:max-w-sm">
              <Label htmlFor="setup-destination">Open in</Label>
              <select
                id="setup-destination"
                data-testid="setup-destination"
                className="form-control form-control-single"
                value={destination}
                onChange={(event) => setDestination(event.target.value as "terminal" | "chat")}
              >
                <option value="terminal">Terminal</option>
                <option value="chat" disabled={setup.backend === "copilot"}>
                  Chat{setup.backend === "copilot" ? " · choose Claude or Codex" : ""}
                </option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="setup-cwd">Working folder on {host ?? "Local"}</Label>
              <select
                data-testid="setup-project-folder"
                aria-label="Fill working folder from a project (optional)"
                className="form-control form-control-single"
                value=""
                onChange={(event) => {
                  if (event.target.value) change({ cwd: event.target.value });
                }}
              >
                <option value="">Use a project folder (optional)…</option>
                {projects.data
                  ?.filter((project) => project.scope)
                  .map((project) => (
                    <option key={project.id} value={project.scope ?? ""}>
                      {project.name}
                    </option>
                  ))}
              </select>
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
                  data-testid="setup-browse"
                  disabled={
                    hostInfo.isFetching ||
                    Boolean(hostInfo.error) ||
                    (!host && !hostInfo.data?.ready)
                  }
                  onClick={async () => {
                    if (host) {
                      setBrowsing(true);
                      return;
                    }
                    try {
                      const result = await api.terminals.pickFolder(setup.cwd || undefined, null);
                      if (result.path) change({ cwd: result.path });
                    } catch (failure) {
                      setError((failure as Error).message);
                    }
                  }}
                >
                  Browse
                </Button>
              </div>
              {browsing && host && (
                <RemoteFolderBrowser
                  key={host}
                  initial={setup.cwd}
                  host={host}
                  onPick={(cwd) => change({ cwd })}
                  onClose={() => setBrowsing(false)}
                />
              )}
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
            <div
              data-testid="setup-components"
              className="rounded-lg bg-surface-low p-3 text-sm space-y-1"
            >
              <p className="font-medium">Configuration to apply</p>
              {profile.data && (
                <>
                  <p>
                    {profile.data.name} · agent instructions
                    {profile.data.fields.model ? ` · ${profile.data.fields.model}` : ""}
                  </p>
                  {host && (
                    <p className="text-xs text-outline">
                      Supporting files referenced by this agent are not transferred. Make them
                      available at the referenced paths on {host}.
                    </p>
                  )}
                </>
              )}
              {components.isFetching && <p>Checking package contents…</p>}
              {components.data?.map((pkg) => (
                <p key={pkg.name} className="wrap-break-word">
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
            Package files are transferred to the selected host when needed. APM deploys agent
            configuration into the working folder; Codex plugins install into Codex's user cache on
            that host. These tools must already be installed. Configuration remains after the
            session; use a terminal for installer trust or conflict prompts.
          </p>
          {unsupported && (
            <p role="alert" className="text-sm text-destructive">
              Choose Codex or Copilot for this Agent Plugin.
            </p>
          )}
          {tools.data && needsApm && !tools.data.apm && (
            <p role="alert" className="text-sm">
              APM 0.33.0 or newer must be available on {host ?? "Local"}.
            </p>
          )}
          {!hostInfo.data?.ready && destination === "terminal" && (
            <p role="alert" className="text-sm">
              {hostInfo.data?.reason ?? "Checking terminal availability…"}
            </p>
          )}
          {(error ||
            command.error ||
            components.error ||
            profile.error ||
            hostInfo.error ||
            ssh.error) && (
            <p role="alert" data-testid="setup-error" className="text-sm text-destructive">
              {error ??
                command.error?.message ??
                components.error?.message ??
                profile.error?.message ??
                hostInfo.error?.message ??
                ssh.error?.message}
            </p>
          )}
          <div className="space-y-1">
            <Label htmlFor="command-mode">Command for your terminal</Label>
            <select
              id="command-mode"
              className="form-control form-control-single"
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
              <Label htmlFor="package-command">
                Run in {command.data.shell} on {host ?? "Local"}
              </Label>
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
        </div>
        <DialogFooter className="shrink-0 border-t px-4 py-3 sm:px-6">
          <Button
            data-testid="setup-command"
            variant="ghost"
            disabled={busy || command.isPending || !canOperate}
            onClick={() => command.mutate({ ...setup, host, operation: commandMode })}
          >
            {command.isPending ? "Preparing command…" : "Command for my terminal"}
          </Button>
          <Button
            data-testid="setup-install"
            variant="ghost"
            disabled={
              busy ||
              command.isPending ||
              !canOperate ||
              !hostInfo.data?.ready ||
              !setup.packages.length
            }
            onClick={() => void perform("install")}
          >
            Install for coding agent
          </Button>
          <Button
            data-testid="setup-launch"
            disabled={
              busy ||
              command.isPending ||
              !canOperate ||
              (destination === "terminal"
                ? !hostInfo.data?.ready || !hostInfo.data?.launchers.includes(setup.backend)
                : !chat.ready || setup.backend === "copilot")
            }
            onClick={() => void perform("run")}
          >
            {busy ? "Preparing…" : destination === "chat" ? "Open in chat" : "Run in ORC terminal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
