import type { JobAction } from "@orc/core/job-actions";
import type { JobSettings } from "@orc/core/job-settings";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSsh } from "@/hooks/useSsh";

const SHELLS = [
  { name: "Host default", executable: "", args: [] },
  ...["sh", "bash", "zsh", "fish"].map((name) => ({ name, executable: name, args: ["-c"] })),
  {
    name: "PowerShell 7 (pwsh)",
    executable: "pwsh",
    args: ["-NoProfile", "-NonInteractive", "-Command"],
  },
  {
    name: "Windows PowerShell",
    executable: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-Command"],
  },
  { name: "cmd", executable: "cmd.exe", args: ["/d", "/s", "/c"] },
];

export function JobDestinationFields({
  settings,
  onChange,
  action,
}: {
  settings: JobSettings;
  onChange: (settings: JobSettings) => void;
  action: JobAction;
}) {
  const { data: ssh } = useSsh();
  const shell = settings.shell;
  const [custom, setCustom] = useState(
    Boolean(
      shell &&
        !SHELLS.some(
          (entry) =>
            entry.executable === shell.executable &&
            JSON.stringify(entry.args) === JSON.stringify(shell.args),
        ),
    ),
  );
  const selected = custom
    ? "Custom"
    : shell
      ? (SHELLS.find(
          (entry) =>
            entry.executable === shell.executable &&
            JSON.stringify(entry.args) === JSON.stringify(shell.args),
        )?.name ?? "Custom")
      : "Host default";
  const selectClass =
    "min-h-11 w-full rounded-md border border-control-border bg-background px-3 text-sm sm:min-h-8";
  return (
    <div className="space-y-4">
      {action.type !== "task" && (
        <div className="space-y-1.5">
          <Label htmlFor="job-host">Runs on</Label>
          <select
            id="job-host"
            data-testid="job-host"
            className={selectClass}
            value={settings.host === undefined ? "__inherit__" : (settings.host ?? "__local__")}
            onChange={(event) => {
              const next = { ...settings };
              if (event.target.value === "__inherit__") delete next.host;
              else next.host = event.target.value === "__local__" ? null : event.target.value;
              onChange(next);
            }}
          >
            <option value="__inherit__">
              Use selected execution host{ssh?.host ? ` (${ssh.host})` : " (local)"}
            </option>
            <option value="__local__">Local API host</option>
            {Array.from(
              new Set([...(ssh?.hosts ?? []), ...(settings.host ? [settings.host] : [])]),
            ).map((host) => (
              <option key={host} value={host}>
                {host}
              </option>
            ))}
          </select>
        </div>
      )}
      {action.type === "command" && (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="job-shell">Shell</Label>
            <select
              id="job-shell"
              data-testid="job-shell"
              className={selectClass}
              value={selected}
              onChange={(event) => {
                setCustom(event.target.value === "Custom");
                const choice = SHELLS.find((entry) => entry.name === event.target.value);
                const next = { ...settings };
                if (choice?.executable)
                  next.shell = { executable: choice.executable, args: choice.args };
                else if (choice) delete next.shell;
                else next.shell = { executable: "", args: ["-c"] };
                onChange(next);
              }}
            >
              {SHELLS.map((entry) => (
                <option key={entry.name}>{entry.name}</option>
              ))}
              <option>Custom</option>
            </select>
          </div>
          {selected === "Custom" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="job-shell-executable">Executable or path</Label>
                <Input
                  id="job-shell-executable"
                  value={shell?.executable ?? ""}
                  required
                  onChange={(event) =>
                    onChange({
                      ...settings,
                      shell: { executable: event.target.value, args: shell?.args ?? [] },
                    })
                  }
                />
              </div>
              <div>
                <Label htmlFor="job-shell-args">Arguments (one per line)</Label>
                <textarea
                  id="job-shell-args"
                  className={`${selectClass} py-2`}
                  value={shell?.args.join("\n") ?? ""}
                  onChange={(event) =>
                    onChange({
                      ...settings,
                      shell: {
                        executable: shell?.executable ?? "",
                        args: event.target.value.split("\n").filter(Boolean),
                      },
                    })
                  }
                />
              </div>
            </div>
          )}
          <p className="text-xs text-outline">
            The script is passed as the final argument. The interpreter must be installed on the
            selected host.
          </p>
        </>
      )}
      {action.type === "agent" && (
        <div className="space-y-3 border-t border-border pt-4">
          <div className="space-y-1.5">
            <Label htmlFor="job-workspace">Workspace</Label>
            <select
              id="job-workspace"
              className={selectClass}
              value={settings.workspace?.mode ?? "directory"}
              onChange={(event) =>
                onChange({
                  ...settings,
                  workspace: {
                    mode: event.target.value === "worktree" ? "worktree" : "directory",
                    base_ref: settings.workspace?.base_ref ?? "HEAD",
                    cleanup_on_success: settings.workspace?.cleanup_on_success ?? false,
                  },
                })
              }
            >
              <option value="worktree">New worktree for each run</option>
              <option value="directory">Use working directory</option>
            </select>
          </div>
          {settings.workspace?.mode === "worktree" && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="job-base-ref">Base branch or ref</Label>
                <Input
                  id="job-base-ref"
                  data-testid="job-base-ref"
                  required
                  value={settings.workspace.base_ref}
                  onChange={(event) =>
                    onChange({
                      ...settings,
                      workspace: {
                        mode: "worktree",
                        cleanup_on_success: settings.workspace?.cleanup_on_success ?? false,
                        base_ref: event.target.value,
                      },
                    })
                  }
                />
                <p className="text-xs text-outline">
                  HEAD inherits the project checkout’s current commit. Override with a local branch
                  or remote-tracking ref. Each run gets an isolated, detached worktree.
                </p>
              </div>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  data-testid="job-cleanup"
                  checked={settings.workspace.cleanup_on_success}
                  onChange={(event) =>
                    onChange({
                      ...settings,
                      workspace: {
                        mode: "worktree",
                        base_ref: settings.workspace?.base_ref ?? "HEAD",
                        cleanup_on_success: event.target.checked,
                      },
                    })
                  }
                />
                Clean up worktree after a successful run
              </label>
              <p className="text-xs text-outline">
                Failed runs, files (including ignored files), and commits absent from the base are
                kept. Run history records the worktree path.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
