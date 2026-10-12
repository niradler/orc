import type { EventRule } from "@orc/core/rule-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useProjects } from "@/hooks/useProjects";
import { EventRuleEditor } from "./EventRuleEditor";

export function RulesPanel() {
  const client = useQueryClient();
  const state = useQuery({ queryKey: ["rules"], queryFn: () => api.rules.list(), retry: false });
  const [workspace, setWorkspace] = useState("");
  const [reason, setReason] = useState("");
  const [denyDelete, setDenyDelete] = useState(true);
  const [denyComments, setDenyComments] = useState(false);
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState<EventRule>();
  const [draft, setDraft] = useState(0);
  const [projectId, setProjectId] = useState<string>("");
  const projects = useProjects();
  const current = state.data?.history.find(
    (row) => row.current && row.workspace.toLowerCase() === workspace.trim().toLowerCase(),
  );
  const effectiveProject = current ? current.project_id : projectId || null;
  const saveEvent = useMutation({
    mutationFn: (rule: EventRule) => {
      if (current?.policy?.rules.some((entry) => entry.id === rule.id && entry.id !== editing?.id))
        throw new Error("Rule name already exists; use Edit rule to update it");
      return api.rules.activate(
        {
          workspace: workspace.trim(),
          project_id: effectiveProject,
          rules: [
            ...(current?.policy?.rules.filter((entry) => entry.id !== (editing?.id ?? rule.id)) ??
              []),
            rule,
          ],
        },
        current?.id ?? null,
        reason,
      );
    },
    onSuccess: () => {
      setMessage("Rule saved. Connect native agents using their event hooks to apply it.");
      setEditing(undefined);
      setDraft((value) => value + 1);
      void client.invalidateQueries({ queryKey: ["rules"] });
    },
    onError: (error) => setMessage(String(error)),
  });
  const save = useMutation({
    mutationFn: () => {
      const current = state.data?.history.find(
        (r) => r.current && r.workspace.toLowerCase() === workspace.trim().toLowerCase(),
      );
      const rules = [
        ...(current?.policy?.rules.filter(
          (r) => r.id !== "prevent-deletion" && r.id !== "prevent-comments",
        ) ?? []),
        ...(denyDelete
          ? [
              {
                id: "prevent-deletion",
                kind: "deny_delete" as const,
                reason: "Prevent file deletion and unmediated execution",
              },
            ]
          : []),
        ...(denyComments
          ? [
              {
                id: "prevent-comments",
                kind: "deny_comments" as const,
                reason: "Prevent new JavaScript/TypeScript comments",
              },
            ]
          : []),
      ];
      return api.rules.activate(
        { workspace: workspace.trim(), project_id: effectiveProject, rules },
        current?.id ?? null,
        reason,
      );
    },
    onSuccess: () => {
      setMessage(
        "Policy saved. Enforcement follows the server rules setting and installed adapters.",
      );
      void client.invalidateQueries({ queryKey: ["rules"] });
    },
    onError: (e) => setMessage(String(e)),
  });
  const revert = useMutation({
    mutationFn: (id: string) => api.rules.revert(id, reason),
    onSuccess: () => {
      setMessage("Previous policy restored; history retained.");
      void client.invalidateQueries({ queryKey: ["rules"] });
    },
    onError: (e) => setMessage(String(e)),
  });
  return (
    <section data-testid="rules-panel" className="space-y-4">
      <h2 className="font-headline font-bold text-sm">Agent rules</h2>
      <p className="text-xs text-outline">
        Choose an agent and event, filter its fields, then select what happens when it matches.
      </p>
      {state.error ? (
        <p role="alert" data-testid="rules-error" className="text-xs">
          {String(state.error)}
        </p>
      ) : (
        <>
          <p data-testid="rules-status" className="text-xs">
            ORC-managed enforcement: {state.data?.enabled ? "enabled" : "disabled"}. Claude SDK is
            supported; other sessions require a qualified native hook.
          </p>
          <Label htmlFor="rules-workspace">Absolute workspace directory</Label>
          <Input
            id="rules-workspace"
            data-testid="rules-workspace"
            value={workspace}
            list="rule-workspaces"
            onChange={(e) => {
              setWorkspace(e.target.value);
              setEditing(undefined);
            }}
          />
          <datalist id="rule-workspaces">
            {state.data?.history
              .filter((row) => row.current)
              .map((row) => (
                <option key={row.id} value={row.workspace} />
              ))}
          </datalist>
          <Label htmlFor="rule-policy-project">Project</Label>
          <select
            id="rule-policy-project"
            data-testid="rule-policy-project"
            value={effectiveProject ?? ""}
            disabled={Boolean(current)}
            className="w-full rounded-md border border-surface-highest bg-background p-2 text-sm"
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">Unassigned</option>
            {projects.data?.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <Label htmlFor="rules-reason">Policy change or restore reason</Label>
          <Input
            id="rules-reason"
            data-testid="rules-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <EventRuleEditor
            key={`${workspace}:${editing?.id ?? `new-${draft}`}`}
            rule={editing}
            projectId={effectiveProject}
            pending={saveEvent.isPending || !workspace.trim() || !reason.trim()}
            onSave={(rule) => saveEvent.mutate(rule)}
          />
          {editing && (
            <Button
              variant="outline"
              onClick={() => {
                setEditing(undefined);
                setDraft((value) => value + 1);
              }}
            >
              New rule
            </Button>
          )}
          <details className="space-y-3 border border-surface-highest rounded-md p-4">
            <summary data-testid="rule-protection-presets" className="cursor-pointer font-bold">
              File protection presets
            </summary>
            <p className="text-xs text-outline">
              Prevent deletion blocks arbitrary shell commands and unverified tools. Comment
              protection supports JavaScript and TypeScript.
            </p>
            <label className="flex gap-2 text-xs">
              <input
                data-testid="rules-delete"
                type="checkbox"
                checked={denyDelete}
                onChange={(e) => setDenyDelete(e.target.checked)}
              />
              Prevent file deletion
            </label>
            <label className="flex gap-2 text-xs">
              <input
                data-testid="rules-comments"
                type="checkbox"
                checked={denyComments}
                onChange={(e) => setDenyComments(e.target.checked)}
              />
              Prevent new code comments
            </label>
            <Button
              data-testid="rules-save"
              disabled={
                save.isPending ||
                !workspace.trim() ||
                !reason.trim() ||
                (!denyDelete && !denyComments)
              }
              onClick={() => save.mutate()}
            >
              Save policy
            </Button>
          </details>
          <h3 className="font-bold">Policies and history</h3>
          <div className="space-y-2">
            {state.data?.history.map((row) => (
              <div
                data-testid="rule-revision"
                data-revision-id={row.id}
                key={row.id}
                className="border-t border-surface-highest pt-2 text-xs"
              >
                <p>
                  {row.workspace} · {row.current ? "current" : "historical"} ·{" "}
                  {row.policy ? `${row.policy.rules.length} rules` : "disabled"}
                </p>
                <p>{row.reason}</p>
                {row.current && (
                  <Button
                    variant="outline"
                    data-testid="rule-load-policy"
                    onClick={() => {
                      setWorkspace(row.workspace);
                      setEditing(undefined);
                      setProjectId(row.project_id ?? "");
                    }}
                  >
                    Load workspace
                  </Button>
                )}
                {row.current &&
                  row.policy?.rules
                    .filter((rule) => rule.kind === "event")
                    .map((rule) => (
                      <div
                        key={rule.id}
                        data-testid="saved-event-rule"
                        className="border border-surface-highest rounded p-2 my-2 space-y-1"
                      >
                        <p>
                          {rule.id} · {rule.enabled ? "enabled" : "disabled"} ·{" "}
                          {rule.scope.agents === "all"
                            ? "All agents"
                            : rule.scope.agents.join(", ")}
                        </p>
                        <p>
                          {rule.scope.events.join(", ")} → {rule.target.type}
                        </p>
                        <Button
                          variant="outline"
                          data-testid="event-rule-edit"
                          onClick={() => {
                            setWorkspace(row.workspace);
                            setEditing(rule);
                          }}
                        >
                          Edit rule
                        </Button>
                      </div>
                    ))}
                <details>
                  <summary>Policy</summary>
                  <pre className="whitespace-pre-wrap break-all">
                    {JSON.stringify(row.policy, null, 2)}
                  </pre>
                </details>
                {row.current && (
                  <Button
                    data-testid="rule-revert"
                    variant="outline"
                    disabled={revert.isPending || !reason.trim()}
                    onClick={() => revert.mutate(row.id)}
                  >
                    Restore previous policy
                  </Button>
                )}
              </div>
            ))}
          </div>
          <details data-testid="rule-connections" className="text-xs space-y-2">
            <summary className="cursor-pointer font-bold">Connect coding agents</summary>
            <p>
              Claude SDK sessions are connected when ORC rule enforcement is enabled. For native
              agents, merge hooks into the chosen JSON settings file. Existing hooks are preserved.
            </p>
            {[
              ["claude", ".claude/settings.json"],
              ["cursor", ".cursor/hooks.json"],
              ["gemini", ".gemini/settings.json"],
              ["codex", ".codex/hooks.json"],
            ].map(([agent, path]) => (
              <p key={agent}>
                <code>
                  orc rules install-hook {agent} --target "
                  {workspace ? `${workspace.split("\\").join("/")}/` : ""}
                  {path}"
                </code>
              </p>
            ))}
            <p>
              Native agents require supported host versions and hook trust. Protocol support does
              not establish host enforcement; ORC-managed non-Claude sessions remain guarded against
              unverified coverage.
            </p>
          </details>
          <details data-testid="rules-decisions">
            <summary>Recent decisions and actions</summary>
            <pre className="text-xs whitespace-pre-wrap break-all">
              {JSON.stringify(
                { decisions: state.data?.decisions, actions: state.data?.actions },
                null,
                2,
              )}
            </pre>
          </details>
        </>
      )}
      {message && (
        <p role="status" data-testid="rules-message" className="text-xs">
          {message}
        </p>
      )}
    </section>
  );
}
