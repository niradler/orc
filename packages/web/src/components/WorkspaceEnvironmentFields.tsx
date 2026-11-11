import type { WorkspaceEnvironment } from "@orc/core/workspace-settings";
import { HelpPopover } from "@/components/HelpPopover";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { JobEnvironmentFields } from "./JobEnvironmentFields";

export function WorkspaceEnvironmentFields({
  value,
  onChange,
}: {
  value: WorkspaceEnvironment;
  onChange: (value: WorkspaceEnvironment) => void;
}) {
  const update = (patch: Partial<WorkspaceEnvironment>) => onChange({ ...value, ...patch });
  return (
    <div className="space-y-4 md:col-span-2" data-testid="project-workspace-settings">
      <div className="flex items-center gap-1">
        <h3 className="text-sm font-medium">Workspace environment</h3>
        <HelpPopover label="Workspace environment" testId="project-workspace-help">
          Applies to terminals, chats, flow nodes and jobs ORC starts for this project. Each
          worktree gets its own port block and runs the setup script once before the first agent
          starts there.
        </HelpPopover>
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <Label htmlFor="project-setup-script">Setup script</Label>
          <HelpPopover label="Setup script" testId="project-setup-script-help">
            Runs once in each new managed worktree before an agent starts. Use{" "}
            <code>$ORC_PORT</code> for services that must bind early. A failure is recorded with its
            output and does not block the agent.
          </HelpPopover>
        </div>
        <Textarea
          id="project-setup-script"
          data-testid="project-setup-script"
          rows={2}
          value={value.setup_script ?? ""}
          placeholder="bun install"
          onChange={(event) => update({ setup_script: event.target.value || null })}
        />
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <Label htmlFor="project-dev-script">Dev server script</Label>
          <HelpPopover label="Dev server script" testId="project-dev-script-help">
            Start it from a project terminal's menu with <strong>Start dev server</strong>. The
            first URL it prints becomes the Preview link.
          </HelpPopover>
        </div>
        <Textarea
          id="project-dev-script"
          data-testid="project-dev-script"
          rows={2}
          value={value.dev_script ?? ""}
          placeholder="bun run dev --port $ORC_PORT"
          onChange={(event) => update({ dev_script: event.target.value || null })}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <div className="flex items-center gap-1">
            <Label htmlFor="project-port-base">Port range start</Label>
            <HelpPopover label="Port range start" testId="project-port-base-help">
              First port of the project pool. Empty starts at 3100. Each workspace takes a
              non-overlapping block of the configured size on this API host.
            </HelpPopover>
          </div>
          <Input
            id="project-port-base"
            data-testid="project-port-base"
            type="number"
            min={1024}
            max={65535}
            value={value.port_base ?? ""}
            placeholder="3100"
            onChange={(event) => {
              const next = event.target.value.trim();
              update({ port_base: next ? Number(next) : null });
            }}
          />
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center gap-1">
            <Label htmlFor="project-port-count">Ports per workspace</Label>
            <HelpPopover label="Ports per workspace" testId="project-port-count-help">
              Exports PORT, ORC_PORT, ORC_PORT_END and ORC_PORT_COUNT plus ORC_PORT_1 through the
              end of the block.
            </HelpPopover>
          </div>
          <Input
            id="project-port-count"
            data-testid="project-port-count"
            type="number"
            min={1}
            max={100}
            value={value.port_count}
            onChange={(event) => update({ port_count: Number(event.target.value) || 1 })}
          />
        </div>
      </div>
      <JobEnvironmentFields
        value={value.env}
        onChange={(env) => update({ env })}
        title="Workspace environment variables"
        help="Injected into terminals, flow nodes and jobs for this project. Secret values are encrypted and write-only after saving; leave a saved secret blank to keep it."
        addTestId="project-env-add"
      />
    </div>
  );
}
