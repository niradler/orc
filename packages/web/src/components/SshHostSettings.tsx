import { Plug, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useBackends } from "@/hooks/useBackends";
import { useSelectSshHost, useSsh, useTestSshHost } from "@/hooks/useSsh";

const LOCAL = "__local__";

function errorText(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

export function SshHostSettings() {
  const { data: ssh } = useSsh();
  const { data: backends } = useBackends();
  const select = useSelectSshHost();
  const test = useTestSshHost();
  const [choice, setChoice] = useState(LOCAL);
  const [port, setPort] = useState("");

  useEffect(() => {
    if (!ssh) return;
    setChoice(ssh.host ?? LOCAL);
    setPort(String(ssh.remote_port));
  }, [ssh]);

  if (!ssh) return null;

  const alias = choice === LOCAL ? null : choice;
  const hosts = ssh.host && !ssh.hosts.includes(ssh.host) ? [ssh.host, ...ssh.hosts] : ssh.hosts;
  const portNumber = Number(port);
  const portValid = Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535;
  const disabled = ssh.locked || !ssh.supported;
  const claude = backends?.backends.find((backend) => backend.name === "claude");
  const result = test.data;

  return (
    <section data-testid="ssh-settings">
      <h2 className="font-headline font-bold text-xs uppercase tracking-widest text-on-surface mb-1">
        Execution Host
      </h2>
      <p className="font-body text-xs text-outline mb-4">
        Run every agent, terminal, git and file action on a host from{" "}
        <code className="text-primary">~/.ssh/config</code>. Agents there reach orc through a
        reverse tunnel on the remote port. Terminals already open keep their host.
      </p>
      <Separator className="bg-surface-highest mb-4" />
      <div className="space-y-4">
        {ssh.locked && (
          <p data-testid="ssh-locked" className="font-body text-[11px] text-tertiary">
            Fixed by ORC_SSH_HOST in orc's environment.
          </p>
        )}
        {!ssh.supported && (
          <p data-testid="ssh-unsupported" className="font-body text-[11px] text-error">
            {ssh.unsupported_reason}
          </p>
        )}
        {!ssh.secret_set && (
          <p data-testid="ssh-secret-missing" className="font-body text-[11px] text-tertiary">
            Set api.secret (or ORC_API_SECRET) before selecting a host. Host agents and terminals
            can execute arbitrary commands through orc.
          </p>
        )}
        <div className="space-y-2">
          <Label className="font-label text-[11px] uppercase tracking-widest text-outline">
            Host
          </Label>
          <Select value={choice} onValueChange={setChoice} disabled={disabled}>
            <SelectTrigger
              data-testid="ssh-host-picker"
              className="bg-surface-highest border-surface-highest text-on-surface font-body text-sm"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-surface-highest border-surface-highest max-h-72">
              <SelectItem value={LOCAL} className="font-label text-xs">
                Local (this machine)
              </SelectItem>
              {hosts.map((host) => (
                <SelectItem key={host} value={host} className="font-label text-xs">
                  {host}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {hosts.length === 0 && (
            <p className="font-body text-[11px] text-outline">
              No Host entries found in ~/.ssh/config on the machine running orc.
            </p>
          )}
        </div>
        <div className="space-y-2">
          <Label className="font-label text-[11px] uppercase tracking-widest text-outline">
            Remote Port
          </Label>
          <Input
            data-testid="ssh-remote-port"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            disabled={disabled || !alias}
            inputMode="numeric"
            className="bg-surface-highest border-surface-highest text-on-surface font-body text-sm"
          />
          <p className="font-body text-[11px] text-outline">
            Change it if the host already listens on this port, e.g. its own orc.
          </p>
        </div>
        <div className="flex gap-3">
          <Button
            data-testid="ssh-save"
            disabled={disabled || (alias !== null && !portValid) || select.isPending}
            onClick={() =>
              select.mutate({
                host: alias,
                remotePort: alias ? portNumber : null,
              })
            }
            className="font-label text-xs uppercase bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25"
          >
            <Save size={12} className="mr-1.5" /> Use Host
          </Button>
          <Button
            data-testid="ssh-test"
            variant="ghost"
            disabled={!alias || !ssh.supported || test.isPending}
            onClick={() => alias && test.mutate(alias)}
            className="font-label text-xs uppercase text-outline hover:text-on-surface"
          >
            <Plug size={12} className="mr-1.5" /> {test.isPending ? "Testing…" : "Test"}
          </Button>
        </div>
        {errorText(select.error ?? test.error) && (
          <p data-testid="ssh-error" className="font-body text-[11px] text-error">
            {errorText(select.error ?? test.error)}
          </p>
        )}
        {result && (
          <div data-testid="ssh-test-result" className="font-body text-[11px] space-y-1">
            {result.ok ? (
              <>
                <p className="text-secondary">
                  Connected to {result.host} ({result.os}, {result.shell})
                </p>
                <p className="text-outline">
                  {Object.entries(result.binaries)
                    .map(([name, path]) => `${path ? "●" : "○"} ${name}`)
                    .join("  ")}
                </p>
                {result.binaries.claude && result.claude_logged_in === false && (
                  <p className={result.api_key_forwarded ? "text-outline" : "text-error"}>
                    claude is not logged in on {result.host}.{" "}
                    {result.api_key_forwarded
                      ? "ANTHROPIC_API_KEY from orc's environment will be forwarded."
                      : "Set ANTHROPIC_API_KEY in orc's environment or run claude login there."}
                  </p>
                )}
              </>
            ) : (
              <p className="text-error">{result.error}</p>
            )}
          </div>
        )}
        {ssh.host && claude && !claude.available && (
          <p data-testid="ssh-claude-error" className="font-body text-[11px] text-error">
            claude backend: {claude.error}
          </p>
        )}
      </div>
    </section>
  );
}
