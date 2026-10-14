import { copyRuleTemplate, RULE_CATALOG } from "@orc/core/rule-catalog";
import { type EventRule, EventRuleSchema, type RulePolicy } from "@orc/core/rule-types";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useProjects } from "@/hooks/useProjects";
import { useViewParam } from "@/lib/view-params";
import { EventRuleEditor } from "./EventRuleEditor";

type Revision = Awaited<ReturnType<typeof api.rules.list>>["history"][number];
type Rule = RulePolicy["rules"][number];
const selectClass = "w-full rounded-md border border-outline-variant bg-background p-2 text-sm";
const agents = ["claude", "codex", "cursor", "gemini"] as const;

function workspaceKey(value: string): string {
  const path = value.trim().split("\\").join("/");
  const normalized = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return /^[a-z]:\//i.test(path) || path.startsWith("//") ? normalized.toLowerCase() : normalized;
}

function actionLabel(rule: Rule): string {
  if (rule.target.type === "orc_action") return rule.target.action.split("_").join(" ");
  return rule.target.type.split("_").join(" ");
}

export function RulesPanel() {
  const client = useQueryClient();
  const state = useQuery({ queryKey: ["rules"], queryFn: () => api.rules.list(), retry: false });
  const projects = useProjects();
  const [tab, setTab] = useViewParam<string>("tab", "applied", ["applied", "settings"]);
  const [workspace, setWorkspaceState] = useViewParam<string>("workspace", "");
  const [projectId, setProjectId] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [agentAssignments, setAgentAssignments] = useState<Record<string, string>>({});
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<EventRule>();
  const [templateRule, setTemplateRule] = useState<EventRule>();
  const [editorPolicy, setEditorPolicy] = useState<Revision>();
  const [templateId, setTemplateId] = useState("");
  const [draft, setDraft] = useState(0);
  const editorTriggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!editorOpen) return;
    const frame = requestAnimationFrame(() => document.getElementById("event-rule-id")?.focus());
    return () => cancelAnimationFrame(frame);
  }, [editorOpen]);
  const current = state.data?.history.find(
    (row) => row.current && workspaceKey(row.workspace) === workspaceKey(workspace),
  );
  const policies =
    state.data?.history.filter(
      (row) =>
        row.current &&
        row.policy &&
        (!workspace || workspaceKey(row.workspace) === workspaceKey(workspace)),
    ) ?? [];

  function selectWorkspace(value: string, replace = false): void {
    setWorkspaceState(value, { replace });
    sessionStorage.setItem("orc_rules_workspace", value);
    if (editorOpen && !editing) {
      setEditorPolicy(
        state.data?.history.find(
          (row) => row.current && workspaceKey(row.workspace) === workspaceKey(value),
        ),
      );
    }
  }

  useEffect(() => {
    setProjectId(current?.project_id ?? "");
    setAgentAssignments({});
  }, [current]);

  function refresh(message: string): void {
    setMessage(message);
    void client.invalidateQueries({ queryKey: ["rules"] });
  }

  function scopedRules(): Rule[] {
    return (current?.policy?.rules ?? []).map((rule) => {
      if (!agentAssignments[rule.id]) return rule;
      const selected = agentAssignments[rule.id];
      return EventRuleSchema.parse({
        ...rule,
        scope: { ...rule.scope, agents: selected === "all" ? "all" : selected.split(",") },
      });
    });
  }

  const saveEvent = useMutation({
    mutationFn: (rule: EventRule) => {
      const policy = editorPolicy;
      if (policy?.policy?.rules.some((entry) => entry.id === rule.id && entry.id !== editing?.id))
        throw new Error("A rule with this name already exists.");
      return api.rules.activate(
        {
          workspace: workspace.trim(),
          project_id: policy ? policy.project_id : projectId || null,
          rules: [
            ...(policy?.policy?.rules.filter((entry) => entry.id !== (editing?.id ?? rule.id)) ??
              []),
            rule,
          ],
        },
        policy?.id ?? null,
        reason.trim() || (editing ? "Updated " : "Added ") + rule.id,
      );
    },
    onSuccess: () => {
      setEditorOpen(false);
      setEditing(undefined);
      setTemplateRule(undefined);
      refresh("Rule saved.");
    },
  });

  const saveSettings = useMutation({
    mutationFn: () => {
      const rules = scopedRules();
      return api.rules.activate(
        { workspace: workspace.trim(), project_id: projectId || null, rules },
        current?.id ?? null,
        reason.trim() || "Updated rule settings",
      );
    },
    onSuccess: () => refresh("Settings saved."),
  });

  const toggle = useMutation({
    mutationFn: ({ policy, rule }: { policy: Revision; rule: EventRule }) =>
      api.rules.activate(
        {
          workspace: policy.workspace,
          project_id: policy.project_id,
          rules:
            policy.policy?.rules.map((entry) =>
              entry.id === rule.id ? { ...rule, enabled: !rule.enabled } : entry,
            ) ?? [],
        },
        policy.id,
        (rule.enabled ? "Disabled " : "Enabled ") + rule.id,
      ),
    onSuccess: () => refresh("Rule status updated."),
    onError: (error) => setMessage(String(error)),
  });

  const revert = useMutation({
    mutationFn: (id: string) =>
      api.rules.revert(id, reason.trim() || "Restored previous rule policy"),
    onSuccess: () => refresh("Previous policy restored."),
    onError: (error) => setMessage(String(error)),
  });

  function beginAdd(button: HTMLButtonElement): void {
    editorTriggerRef.current = button;
    saveEvent.reset();
    setEditing(undefined);
    setTemplateRule(undefined);
    setEditorPolicy(current);
    setTemplateId("");
    setDraft((value) => value + 1);
    setEditorOpen(true);
  }

  function beginEdit(policy: Revision, rule: EventRule, button: HTMLButtonElement): void {
    editorTriggerRef.current = button;
    saveEvent.reset();
    selectWorkspace(policy.workspace);
    setEditorPolicy(policy);
    setProjectId(policy.project_id ?? "");
    setEditing(structuredClone(rule));
    setTemplateRule(undefined);
    setDraft((value) => value + 1);

    setEditorOpen(true);
  }

  function renderScope(): ReactNode {
    return (
      <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
        <div className="space-y-2">
          <Label htmlFor="rules-workspace">Workspace directory</Label>
          <Input
            id="rules-workspace"
            data-testid="rules-workspace"
            list="rule-workspaces"
            value={workspace}
            disabled={editorOpen && Boolean(editorPolicy)}
            onChange={(event) => selectWorkspace(event.target.value, true)}
            placeholder="Absolute project directory"
          />
          <datalist id="rule-workspaces">
            {state.data?.history
              .filter((row) => row.current)
              .map((row) => (
                <option key={row.id} value={row.workspace} />
              ))}
          </datalist>
        </div>
        <div className="space-y-2">
          <Label htmlFor="rule-policy-project">Project</Label>
          <select
            id="rule-policy-project"
            data-testid="rule-policy-project"
            className={selectClass}
            value={projectId}
            disabled={editorOpen && Boolean(editorPolicy)}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">Unassigned</option>
            {projects.data?.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>
      </div>
    );
  }

  return (
    <section data-testid="rules-panel" className="space-y-4">
      {state.error && (
        <p role="alert" data-testid="rules-error">
          <span data-testid="page-error">{String(state.error)}</span>
        </p>
      )}
      <Tabs value={tab} onValueChange={setTab}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList className="h-auto max-w-full flex-wrap">
            <TabsTrigger value="applied" data-testid="rules-applied-tab">
              Applied rules
            </TabsTrigger>
            <TabsTrigger value="settings" data-testid="rules-settings-tab">
              Settings
            </TabsTrigger>
          </TabsList>
          <Button data-testid="rule-new" onClick={(event) => beginAdd(event.currentTarget)}>
            Add rule
          </Button>
        </div>
        <TabsContent value="applied" className="space-y-4 pt-3">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <select
              data-testid="rules-workspace-filter"
              aria-label="Filter by workspace"
              className="max-w-sm rounded-md border border-outline-variant bg-background p-2 text-sm"
              value={current?.workspace ?? workspace}
              onChange={(event) => selectWorkspace(event.target.value)}
            >
              <option value="">All workspaces</option>
              {workspace && !current && <option value={workspace}>{workspace}</option>}
              {state.data?.history
                .filter((row) => row.current)
                .map((row) => (
                  <option key={row.id} value={row.workspace}>
                    {projects.data?.find((project) => project.id === row.project_id)?.name ??
                      row.workspace}
                  </option>
                ))}
            </select>
            <span data-testid="rules-status" className="text-xs text-muted-foreground">
              Enforcement {state.data?.enabled ? "on" : "off"}
            </span>
          </div>
          <div className="overflow-x-auto rounded-md border border-outline-variant">
            <table
              data-testid="applied-rules-table"
              className="w-full min-w-[860px] table-fixed text-left text-sm"
            >
              <colgroup>
                <col style={{ width: "18%" }} />
                <col style={{ width: "9%" }} />
                <col style={{ width: "10%" }} />
                <col style={{ width: "12%" }} />
                <col style={{ width: "17%" }} />
                <col style={{ width: "18%" }} />
                <col style={{ width: "136px" }} />
              </colgroup>
              <thead className="bg-surface-high text-xs text-muted-foreground">
                <tr>
                  {[
                    "Rule",
                    "Status",
                    "Agents",
                    "Trigger",
                    "Action",
                    "Project / workspace",
                    "Actions",
                  ].map((heading, index) => (
                    <th
                      key={heading}
                      className={`px-3 py-3 font-medium ${index === 6 ? "sticky right-0 bg-surface-high" : ""}`}
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              {policies.map((policy) => (
                <tbody key={policy.id} data-testid="rule-revision" data-revision-id={policy.id}>
                  {policy.policy?.rules.map((rule) => (
                    <tr
                      key={rule.id}
                      data-testid="saved-event-rule"
                      className="border-t border-outline-variant"
                    >
                      <td className="px-3 py-3 font-medium">
                        <span className="block truncate" title={rule.id}>
                          {rule.id}
                        </span>
                      </td>
                      <td className="px-4 py-3">{!rule.enabled ? "Disabled" : "Enabled"}</td>
                      <td className="px-3 py-3">
                        {rule.scope.agents !== "all" ? rule.scope.agents.join(", ") : "All agents"}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {rule.scope.events.join(", ").split("_").join(" ")}
                      </td>
                      <td className="px-3 py-3">
                        <span className="block truncate" title={actionLabel(rule)}>
                          {actionLabel(rule)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className="block truncate text-xs text-muted-foreground"
                          title={policy.workspace}
                        >
                          {projects.data?.find((project) => project.id === policy.project_id)
                            ?.name ?? "Unassigned"}
                        </span>
                        <span
                          className="block truncate text-xs text-muted-foreground"
                          title={policy.workspace}
                        >
                          {policy.workspace}
                        </span>
                      </td>
                      <td className="sticky right-0 bg-background px-3 py-3">
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            data-testid="event-rule-edit"
                            onClick={(event) => beginEdit(policy, rule, event.currentTarget)}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            data-testid="event-rule-toggle"
                            disabled={toggle.isPending}
                            onClick={() => toggle.mutate({ policy, rule })}
                          >
                            {rule.enabled ? "Disable" : "Enable"}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
            {state.isPending && (
              <p
                role="status"
                data-testid="page-loading"
                className="p-8 text-sm text-muted-foreground"
              >
                Loading rules…
              </p>
            )}
            {!state.isPending &&
              !state.error &&
              !policies.some((policy) => policy.policy?.rules.length) && (
                <div
                  className="p-10 text-center text-sm text-muted-foreground"
                  data-testid="rules-empty"
                >
                  <span data-testid="page-empty">
                    No applied rules. Add a rule from scratch or choose a template.
                  </span>
                </div>
              )}
          </div>
        </TabsContent>
        <TabsContent value="settings" className="space-y-6 pt-4">
          {!editorOpen && (
            <>
              <div className="space-y-4">
                <h3 className="font-medium">Applies to</h3>
                {renderScope()}
                <p className="text-xs text-muted-foreground">
                  Rules apply in this directory and its subdirectories.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="rules-reason">Change note (optional)</Label>
                <Input
                  id="rules-reason"
                  data-testid="rules-reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </div>
              {current?.policy?.rules.length && (
                <div className="space-y-3">
                  <h3 className="font-medium">Agent assignments</h3>
                  {current.policy.rules.map((rule) => (
                    <div key={rule.id} className="grid items-center gap-3 sm:grid-cols-2">
                      <Label htmlFor={`agent-${rule.id}`}>{rule.id}</Label>
                      <select
                        id={`agent-${rule.id}`}
                        data-testid="rule-agent-assignment"
                        className={selectClass}
                        value={
                          agentAssignments[rule.id] ??
                          (rule.scope.agents === "all" ? "all" : rule.scope.agents.join(","))
                        }
                        onChange={(event) =>
                          setAgentAssignments((previous) => ({
                            ...previous,
                            [rule.id]: event.target.value,
                          }))
                        }
                      >
                        <option value="all">All agents</option>
                        {agents.map((agent) => (
                          <option key={agent} value={agent}>
                            {agent}
                          </option>
                        ))}
                        {rule.scope.agents !== "all" && rule.scope.agents.length > 1 && (
                          <option value={rule.scope.agents.join(",")}>
                            {rule.scope.agents.join(", ")}
                          </option>
                        )}
                      </select>
                    </div>
                  ))}
                </div>
              )}
              <Button
                data-testid="rules-settings-save"
                disabled={
                  saveSettings.isPending || !workspace.trim() || !current?.policy?.rules.length
                }
                onClick={() => saveSettings.mutate()}
              >
                Save settings
              </Button>
              {saveSettings.error && (
                <p role="alert" data-testid="rules-settings-error">
                  {String(saveSettings.error)}
                </p>
              )}
              <details
                data-testid="rule-connections"
                className="space-y-3 border-t border-outline-variant pt-4"
              >
                <summary className="cursor-pointer font-medium">Agent connections</summary>
                <p className="text-xs text-muted-foreground">
                  Claude SDK sessions connect when rule enforcement is enabled. Native agents need
                  installed, trusted hooks and a supported host.
                </p>
                {agents.map((agent) => (
                  <p key={agent} className="text-xs break-all">
                    <code>
                      orc rules install-hook {agent} --target "
                      {workspace ? `${workspace.split("\\").join("/")}/` : ""}.
                      {agent === "gemini" ? "gemini" : agent}/
                      {agent === "cursor" || agent === "codex" ? "hooks" : "settings"}.json"
                    </code>
                  </p>
                ))}
              </details>
              <details
                data-testid="rules-history"
                className="space-y-3 border-t border-outline-variant pt-4"
              >
                <summary className="cursor-pointer font-medium">Policy history</summary>
                {state.data?.history
                  .filter(
                    (row) => !workspace || workspaceKey(row.workspace) === workspaceKey(workspace),
                  )
                  .map((row) => (
                    <div
                      key={row.id}
                      data-testid="rule-history-entry"
                      className="space-y-2 border-t border-outline-variant py-3 text-xs"
                    >
                      <p className="break-all">
                        {row.workspace} · {row.current ? "Current" : "Historical"} ·{" "}
                        {row.policy ? `${row.policy.rules.length} rules` : "Disabled"}
                      </p>
                      <p>{row.reason}</p>
                      {row.current && (
                        <Button
                          size="sm"
                          data-testid="rule-revert"
                          disabled={revert.isPending}
                          onClick={() => revert.mutate(row.id)}
                        >
                          Restore previous policy
                        </Button>
                      )}
                      <details>
                        <summary>View policy</summary>
                        <pre className="whitespace-pre-wrap break-all">
                          {JSON.stringify(row.policy, null, 2)}
                        </pre>
                      </details>
                    </div>
                  ))}
              </details>
              <details
                data-testid="rules-decisions"
                className="border-t border-outline-variant pt-4"
              >
                <summary className="cursor-pointer font-medium">Activity</summary>
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
        </TabsContent>
      </Tabs>
      <Sheet open={editorOpen} onOpenChange={setEditorOpen}>
        <SheetContent
          className="w-[640px] max-w-[100vw]"
          data-testid="rule-editor-panel"
          aria-describedby="rule-editor-description"
          onOpenAutoFocus={(event) => {
            if (editorOpen) {
              event.preventDefault();
              document.getElementById("event-rule-id")?.focus();
            }
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            editorTriggerRef.current?.focus();
          }}
        >
          <SheetHeader>
            <SheetTitle>{editing ? `Edit ${editing.id}` : "Add rule"}</SheetTitle>
            <SheetDescription id="rule-editor-description">
              Select a template to fill the form, or define a rule from scratch.
            </SheetDescription>
          </SheetHeader>
          <SheetBody className="space-y-4" data-testid="rule-editor-region">
            {!editing && (
              <div className="space-y-2" data-testid="rule-catalog">
                <Label htmlFor="rule-template">Start with</Label>
                <select
                  id="rule-template"
                  data-testid="rule-template"
                  className={selectClass}
                  value={templateId}
                  onChange={(event) => {
                    const id = event.target.value;
                    setTemplateId(id);
                    const rule = id ? copyRuleTemplate(id) : undefined;
                    if (rule) {
                      const existing = new Set(
                        editorPolicy?.policy?.rules.map((entry) => entry.id),
                      );
                      let index = 2;
                      while (existing.has(rule.id)) rule.id = `${id}-${index++}`;
                    }
                    setTemplateRule(rule);
                    setDraft((value) => value + 1);
                  }}
                >
                  <option value="">From scratch</option>
                  {RULE_CATALOG.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </select>
                {templateId && (
                  <div className="space-y-2">
                    <p data-testid="rule-template-description" className="text-sm">
                      {RULE_CATALOG.find((entry) => entry.id === templateId)?.description}
                    </p>
                    <p data-testid="rule-template-limits" className="text-xs text-muted-foreground">
                      {RULE_CATALOG.find((entry) => entry.id === templateId)?.configuration}
                    </p>
                  </div>
                )}
              </div>
            )}

            {!workspace.trim() ? (
              renderScope()
            ) : (
              <details className="space-y-3">
                <summary className="cursor-pointer text-xs text-muted-foreground">
                  Applies to {workspace}
                </summary>
                {renderScope()}
              </details>
            )}
            <EventRuleEditor
              key={`${editing?.id ?? "new"}:${draft}`}
              rule={editing ?? templateRule}
              isEditing={Boolean(editing)}
              projectId={editorPolicy ? editorPolicy.project_id : projectId || null}
              pending={saveEvent.isPending || !workspace.trim()}
              onSave={(rule) => saveEvent.mutate(rule)}
            />
            {saveEvent.error && (
              <p role="alert" data-testid="rule-save-error">
                {String(saveEvent.error)}
              </p>
            )}
          </SheetBody>
        </SheetContent>
      </Sheet>
      {message && (
        <p role="status" data-testid="rules-message" className="text-sm">
          {message}
        </p>
      )}
    </section>
  );
}
