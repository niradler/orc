import {
  ChannelCommandsSchema,
  type ChannelCondition,
  type ChannelConnection,
  ChannelConnectionSchema,
  type ChannelProviderInfo,
  type ChannelRoute,
  ChannelRouteSchema,
  type ChannelTarget,
  ChannelTargetSchema,
  type ChannelView,
  channelCommands,
  isChannelCatchAll,
  validChannelCondition,
} from "@orc/core/channels";
import { CHAT_AGENTS } from "@orc/core/chat";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Pencil } from "lucide-react";
import { cloneElement, type ReactElement, useId, useState } from "react";
import { api } from "@/api/client";
import {
  ChannelConditionBuilder,
  channelConditionSummary,
} from "@/components/ChannelConditionBuilder";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useBackends } from "@/hooks/useBackends";

const conditionDefault: ChannelCondition = { field: "is_direct", op: "is", value: true };
const defaultRouteCondition: ChannelCondition = {
  all: [{ field: "kind", op: "is", value: "message" }, conditionDefault],
};
const control = "form-control form-control-single w-full";
type Project = { id: string; name: string };
function routeActionLabel(route: Pick<ChannelRoute, "action">, projects: Project[]): string {
  const action = route.action;
  if (action.type === "ignore") return "Ignore silently · no agent starts";
  const project = projects.find((project) => project.id === action.project_id);
  return `Agent: ${action.agent} · Project: ${project?.name ?? action.project_id}${action.model ? ` · Model: ${action.model}` : ""}`;
}

function connectionDraft(view: ChannelView): ChannelConnection {
  const {
    status: _status,
    identity: _identity,
    error: _error,
    credentials: _credentials,
    ...data
  } = view;
  return ChannelConnectionSchema.parse({ ...data, credentials: {} });
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 accent-primary"
      />
      {label}
    </label>
  );
}
function Field({ label, children }: { label: string; children: ReactElement<{ id?: string }> }) {
  const id = useId();
  return (
    <label htmlFor={id} className="grid min-w-0 gap-1 text-sm">
      <span>{label}</span>
      {cloneElement(children, { id })}
    </label>
  );
}

function TargetEditor({
  value,
  projects,
  onSave,
  onCancel,
}: {
  value: ChannelTarget;
  projects: Project[];
  onSave: (v: ChannelTarget) => void;
  onCancel: () => void;
}) {
  const [target, setTarget] = useState(value);
  const [error, setError] = useState("");
  return (
    <div className="space-y-3 border-t border-border py-3" data-testid="channel-target-editor">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Recipient alias">
          <Input
            data-testid="channel-target-id"
            value={target.id}
            onChange={(e) => setTarget({ ...target, id: e.target.value })}
          />
        </Field>
        <Field label="Display name">
          <Input
            data-testid="channel-target-name"
            value={target.name}
            onChange={(e) => setTarget({ ...target, name: e.target.value })}
          />
        </Field>
        <Field label="Provider chat / channel ID">
          <Input
            data-testid="channel-target-chat"
            value={target.chat_id}
            onChange={(e) => setTarget({ ...target, chat_id: e.target.value })}
          />
        </Field>
        <Field label="Thread ID (optional)">
          <Input
            value={target.thread_id ?? ""}
            onChange={(e) => {
              const { thread_id: _thread, ...rest } = target;
              setTarget(e.target.value ? { ...rest, thread_id: e.target.value } : rest);
            }}
          />
        </Field>
      </div>
      <Field label="Approved sender IDs (comma separated)">
        <Input
          data-testid="channel-target-users"
          value={target.user_ids.join(", ")}
          onChange={(e) =>
            setTarget({ ...target, user_ids: e.target.value.split(",").map((s) => s.trim()) })
          }
        />
      </Field>
      <div className="flex flex-wrap gap-x-5">
        <Check
          label="Allow outbound"
          checked={target.outbound}
          onChange={(v) => setTarget({ ...target, outbound: v })}
        />
        <Check
          label="Allow inbound"
          checked={target.inbound}
          onChange={(v) => setTarget({ ...target, inbound: v })}
        />
        <Check
          label="Questions and approvals"
          checked={target.attention}
          onChange={(v) => setTarget({ ...target, attention: v })}
        />
      </div>
      <details>
        <summary className="min-h-11 cursor-pointer py-3 text-sm">
          Project restrictions ({target.project_ids.length || "all projects"})
        </summary>
        <div className="flex flex-wrap gap-x-4">
          {projects.map((p) => (
            <Check
              key={p.id}
              label={p.name}
              checked={target.project_ids.includes(p.id)}
              onChange={(v) =>
                setTarget({
                  ...target,
                  project_ids: v
                    ? [...target.project_ids, p.id]
                    : target.project_ids.filter((id) => id !== p.id),
                })
              }
            />
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          No selection allows all projects. Inbound always requires approved sender IDs.
        </p>
      </details>
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          type="button"
          data-testid="channel-target-apply"
          onClick={() => {
            try {
              const parsed = ChannelTargetSchema.parse({
                ...target,
                user_ids: target.user_ids.filter(Boolean),
              });
              if (parsed.inbound && !parsed.user_ids.length)
                throw new Error("Inbound requires at least one approved sender ID.");
              onSave(parsed);
            } catch (e) {
              setError(e instanceof Error ? e.message : "Invalid recipient");
            }
          }}
        >
          Apply recipient
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function RouteEditor({
  value,
  projects,
  onSave,
  onCancel,
}: {
  value: ChannelRoute;
  projects: Project[];
  onSave: (v: ChannelRoute) => void;
  onCancel: () => void;
}) {
  const [route, setRoute] = useState(value);
  const [error, setError] = useState("");
  const [conditionValid, setConditionValid] = useState(validChannelCondition(value.condition));
  return (
    <div className="space-y-3 border-t border-border py-3" data-testid="channel-route-editor">
      <Field label="Rule name">
        <Input
          data-testid="channel-route-name"
          value={route.name}
          onChange={(e) => setRoute({ ...route, name: e.target.value })}
        />
      </Field>
      <Check
        label="Rule enabled"
        checked={route.enabled}
        onChange={(v) => setRoute({ ...route, enabled: v })}
      />
      {isChannelCatchAll(route.condition) ? (
        <p className="text-sm text-muted-foreground">
          Runs only when no enabled rule above matches. Recipient and project permissions still
          apply.
        </p>
      ) : (
        validChannelCondition(value.condition) && (
          <ChannelConditionBuilder
            value={value.condition}
            onChange={(condition) => setRoute({ ...route, condition })}
            onValidity={setConditionValid}
          />
        )
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Action">
          <select
            aria-label="Route action"
            className={control}
            value={route.action.type}
            onChange={(e) =>
              setRoute({
                ...route,
                action:
                  e.target.value === "ignore"
                    ? { type: "ignore" }
                    : { type: "agent", agent: "default", project_id: projects[0]?.id ?? "" },
              })
            }
          >
            <option value="agent">Invoke agent</option>
            <option value="ignore">Ignore silently</option>
          </select>
        </Field>
        {route.action.type === "agent" && (
          <>
            <Field label="Agent backend">
              <Input
                data-testid="channel-route-agent"
                placeholder="default, codex-cli, claude, …"
                value={route.action.agent}
                onChange={(e) => {
                  if (route.action.type === "agent")
                    setRoute({ ...route, action: { ...route.action, agent: e.target.value } });
                }}
              />
            </Field>
            <Field label="Project">
              <select
                data-testid="channel-route-project"
                className={control}
                value={route.action.project_id}
                onChange={(e) => {
                  if (route.action.type === "agent")
                    setRoute({ ...route, action: { ...route.action, project_id: e.target.value } });
                }}
              >
                <option value="">Choose a project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Default model (optional)">
              <Input
                data-testid="channel-route-model"
                placeholder="Use the agent default"
                value={route.action.model ?? ""}
                onChange={(e) => {
                  if (route.action.type === "agent") {
                    const { model: _model, ...action } = route.action;
                    setRoute({
                      ...route,
                      action: e.target.value ? { ...action, model: e.target.value } : action,
                    });
                  }
                }}
              />
            </Field>
            <Field label="Agent profile (optional)">
              <Input
                value={route.action.profile ?? ""}
                onChange={(e) => {
                  if (route.action.type === "agent") {
                    const { profile: _profile, ...action } = route.action;
                    setRoute({
                      ...route,
                      action: e.target.value ? { ...action, profile: e.target.value } : action,
                    });
                  }
                }}
              />
            </Field>
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          type="button"
          data-testid="channel-route-apply"
          disabled={!conditionValid}
          onClick={() => {
            try {
              const parsed = ChannelRouteSchema.safeParse(route);
              if (!parsed.success) {
                const field = parsed.error.issues[0]?.path[0];
                setError(
                  field === "name"
                    ? "Give this rule a name."
                    : field === "action"
                      ? "Choose a project and a valid agent, model and profile."
                      : "Complete the rule conditions.",
                );
                return;
              }
              onSave(parsed.data);
            } catch (e) {
              setError(e instanceof Error ? e.message : "Invalid rule");
            }
          }}
        >
          Apply rule
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ConnectionEditor({
  draft,
  provider,
  projects,
  update,
  run,
  onClose,
}: {
  draft: ChannelConnection;
  provider: ChannelProviderInfo;
  projects: Project[];
  update: (v: ChannelConnection) => void;
  run: (work: () => Promise<string>) => Promise<void>;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [target, setTarget] = useState<{ original: string | null; value: ChannelTarget } | null>(
    null,
  );
  const [rule, setRule] = useState<ChannelRoute | null>(null);
  const [replyTarget, setReplyTarget] = useState<string | null>(null);
  const [replyProject, setReplyProject] = useState(projects[0]?.id ?? "");
  const [replyAgent, setReplyAgent] = useState("default");
  const { data: backends } = useBackends();
  const replyAgents = Array.from(
    new Set([
      "default",
      ...CHAT_AGENTS,
      ...(backends?.backends.map((backend) => backend.name) ?? []),
      replyAgent,
    ]),
  );
  const [replyModel, setReplyModel] = useState("");
  const [shortcut, setShortcut] = useState<{
    original: string | null;
    command: string;
    description: string;
    prompt: string;
  } | null>(null);
  const shortcuts = channelCommands(draft.config);
  const setShortcuts = (commands: typeof shortcuts) => {
    const next = { ...draft.config, commands };
    update({ ...draft, config: next });
    setConfigText(JSON.stringify(next, null, 2));
  };
  const [pair, setPair] = useState<{ id: string; url: string; message: string } | null>(null);
  const [configText, setConfigText] = useState(JSON.stringify(draft.config, null, 2));
  const [configError, setConfigError] = useState("");
  const pairState = useQuery({
    queryKey: ["channel-pairing", pair?.id],
    queryFn: () => api.channels.pairing(pair?.id ?? ""),
    enabled: !!pair,
    refetchInterval: pairStateInterval,
  });
  function pairStateInterval(query: { state: { data?: { confirmed?: boolean } } }) {
    return query.state.data?.confirmed ? false : 2000;
  }
  const [probe, setProbe] = useState({
    sender: "",
    chat: "",
    text: "",
    is_direct: true,
    is_mention: false,
  });

  const ruleEditor = rule && (
    <RouteEditor
      key={rule.id}
      value={rule}
      projects={projects}
      onCancel={() => setRule(null)}
      onSave={(value) => {
        const exists = draft.routes.some((r) => r.id === value.id);
        const routes = exists
          ? draft.routes.map((r) => (r.id === value.id ? value : r))
          : isChannelCatchAll(value.condition)
            ? [...draft.routes, value]
            : [
                ...draft.routes.filter((r) => !isChannelCatchAll(r.condition)),
                value,
                ...draft.routes.filter((r) => isChannelCatchAll(r.condition)),
              ];
        update({ ...draft, routes });
        setRule(null);
      }}
    />
  );
  const fallback = draft.routes.find((route) => isChannelCatchAll(route.condition));
  return (
    <div className="space-y-4 border-t border-border pt-4" data-testid="channel-editor">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-medium">
          {draft.revision ? "Edit connection" : "Set up connection"}
        </h3>
        <Button type="button" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Connection ID">
          <Input
            data-testid="channel-id"
            disabled={draft.revision > 0}
            value={draft.id}
            onChange={(e) => update({ ...draft, id: e.target.value })}
          />
        </Field>
        <Field label="Name">
          <Input
            data-testid="channel-name"
            value={draft.name}
            onChange={(e) => update({ ...draft, name: e.target.value })}
          />
        </Field>
      </div>
      <p className="text-sm text-muted-foreground">{provider.setup.join(" ")}</p>
      {provider.credentials.map((field) => (
        <div key={field.key} className="flex flex-wrap items-end gap-2">
          <div className="w-full min-w-0 sm:w-auto sm:flex-1">
            <Field label={field.label}>
              <Input
                autoComplete="off"
                type="password"
                data-testid={`channel-credential-${field.key}`}
                value={draft.credentials[field.key] ?? ""}
                placeholder="Leave blank to keep the configured credential"
                onChange={(e) =>
                  update({
                    ...draft,
                    credentials: { ...draft.credentials, [field.key]: e.target.value },
                  })
                }
              />
            </Field>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              update({
                ...draft,
                credentials: { ...draft.credentials, [field.key]: `env:${field.env}` },
              })
            }
          >
            Use {field.env}
          </Button>
        </div>
      ))}
      {draft.provider === "slack" && (
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            void run(async () => {
              const manifest = await api.channels.manifest();
              await navigator.clipboard.writeText(JSON.stringify(manifest, null, 2));
              return "Slack app manifest copied. Create an app at api.slack.com/apps using this manifest.";
            })
          }
        >
          Copy Slack app manifest
        </Button>
      )}
      <details>
        <summary className="min-h-11 cursor-pointer py-3 text-sm">
          Provider configuration (advanced)
        </summary>
        <p className="mb-2 text-xs text-muted-foreground">
          Set connection-wide native message options under message_defaults. Per-message overrides
          take precedence. Keep credentials in the credential fields above.
        </p>
        <textarea
          aria-label="Provider configuration JSON"
          className="form-control min-h-28 w-full font-mono text-xs"
          value={configText}
          onChange={(e) => {
            setConfigText(e.target.value);
            try {
              const parsed = ChannelConnectionSchema.parse({
                ...draft,
                config: JSON.parse(e.target.value),
              });
              update(parsed);
              setConfigError("");
            } catch {
              setConfigError("Enter a valid JSON object for provider configuration.");
            }
          }}
        />
        {configError && (
          <p role="alert" className="text-sm text-error">
            {configError}
          </p>
        )}
      </details>
      <Check
        label="Connection enabled"
        checked={draft.enabled}
        onChange={(enabled) => update({ ...draft, enabled })}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          data-testid="channel-save"
          disabled={!!target || !!rule || !!shortcut || !!replyTarget || !!configError}
          onClick={() =>
            void run(async () => {
              const result = await api.channels.save(draft);
              update(connectionDraft(result));
              await client.invalidateQueries({ queryKey: ["channels"] });
              return result.error ? `Saved. ${result.error}` : "Connection saved.";
            })
          }
        >
          Save connection
        </Button>
        <Button
          variant="outline"
          onClick={() =>
            void run(async () => {
              const identity = await api.channels.verify(draft.id);
              return `Verified ${identity.name} (${identity.id}).`;
            })
          }
        >
          Verify identity
        </Button>
        {
          <Button
            variant="outline"
            onClick={() =>
              void run(async () => {
                const result = await api.channels.pair(draft.id);
                setPair(result);
                return draft.provider === "telegram"
                  ? "Open the pairing link, start the bot, then confirm the recipient here."
                  : "Open your workspace, message the ORC app with the pairing text below, then confirm the recipient here.";
              })
            }
          >
            Pair my {draft.provider === "telegram" ? "Telegram" : "Slack"}
          </Button>
        }
      </div>
      {pair && (
        <div className="space-y-2 border-l-2 border-border pl-3">
          <a
            href={pair.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-11 items-center underline"
          >
            {draft.provider === "telegram" ? "Open Telegram pairing link" : "Open Slack workspace"}
          </a>
          {draft.provider === "slack" && (
            <div>
              <p className="text-sm">Send this text in a direct message to the ORC app:</p>
              <code className="break-all text-xs">{pair.message}</code>
              <Button
                variant="ghost"
                onClick={() =>
                  void run(async () => {
                    await navigator.clipboard.writeText(pair.message);
                    return "Pairing text copied.";
                  })
                }
              >
                Copy pairing text
              </Button>
            </div>
          )}
          {pairState.error && <p role="alert">{pairState.error.message}</p>}
          {pairState.data?.candidate && !pairState.data.confirmed && (
            <>
              <p className="text-sm">
                Confirm user {pairState.data.candidate.user_id} in chat{" "}
                {pairState.data.candidate.chat_id}. This sets the recipient alias “me”.
              </p>
              <Button
                onClick={() =>
                  void run(async () => {
                    await api.channels.confirmPairing(pair.id);
                    const saved = (await api.channels.list()).find((c) => c.id === draft.id);
                    if (saved) update(connectionDraft(saved));
                    setPair(null);
                    await client.invalidateQueries({ queryKey: ["channels"] });
                    return "Recipient me paired. Enable inbound and add a route to invoke an agent.";
                  })
                }
              >
                Confirm recipient
              </Button>
            </>
          )}
        </div>
      )}
      <details>
        <summary className="min-h-11 cursor-pointer py-3 text-sm">
          Recipients ({draft.targets.length})
        </summary>
        <div className="divide-y divide-border">
          {draft.targets.map((t) => (
            <div
              key={t.id}
              className="flex min-h-11 flex-wrap items-center justify-between gap-2 py-1"
            >
              <div className="min-w-0 text-sm">
                <span className="font-medium">{t.name}</span>
                <span className="ml-2 text-muted-foreground">
                  {t.id} ·{" "}
                  {t.inbound && t.outbound
                    ? "send + receive"
                    : t.inbound
                      ? "receive only"
                      : "send only"}
                </span>
              </div>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  data-testid={`channel-enable-replies-${t.id}`}
                  onClick={() => {
                    setReplyTarget(t.id);
                    setReplyProject(t.project_ids[0] ?? projects[0]?.id ?? "");
                  }}
                >
                  Set up agent replies
                </Button>
                <Button variant="ghost" onClick={() => setTarget({ original: t.id, value: t })}>
                  Edit {t.id}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() =>
                    void run(async () => {
                      const r = await api.channels.send({
                        connection: draft.id,
                        target: t.id,
                        message: {
                          text: "**ORC connected**\nYour channel is ready for messages.",
                          format: "markdown",
                          links: [],
                        },
                        idempotency_key: crypto.randomUUID(),
                      });
                      if (r.status !== "accepted") throw new Error(r.error ?? r.status);
                      return `Test accepted by provider. Receipt ${r.id}.`;
                    })
                  }
                >
                  Test {t.id}
                </Button>
              </div>
            </div>
          ))}
        </div>
        <Button
          variant="outline"
          onClick={() =>
            setTarget({
              original: null,
              value: {
                id: draft.targets.length ? `recipient-${draft.targets.length + 1}` : "me",
                name: "",
                chat_id: "",
                user_ids: [],
                project_ids: [],
                inbound: false,
                outbound: true,
                attention: false,
              },
            })
          }
        >
          Add recipient
        </Button>
        {replyTarget && (
          <div
            className="space-y-2 border-t border-border py-3"
            data-testid="channel-replies-setup"
          >
            <p className="text-sm">
              Allow approved senders for {replyTarget} to talk to an agent and answer its questions.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label="Reply project">
                <select
                  className={control}
                  value={replyProject}
                  onChange={(e) => setReplyProject(e.target.value)}
                  data-testid="channel-replies-project"
                >
                  <option value="">Choose project</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Reply agent">
                <select
                  className={control}
                  value={replyAgent}
                  onChange={(e) => setReplyAgent(e.target.value)}
                  data-testid="channel-replies-agent"
                >
                  {replyAgents.map((agent) => (
                    <option key={agent} value={agent}>
                      {agent === "default" ? "Default (Chat Settings)" : agent}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Reply model (optional)">
              <Input
                data-testid="channel-replies-model"
                value={replyModel}
                onChange={(e) => setReplyModel(e.target.value)}
                placeholder="Use the agent default"
              />
            </Field>
            <p className="text-xs text-muted-foreground">
              The reply project is the default. Use “default” for the agent to follow Chat Settings.
              /projects, /agent and /model can change this conversation's choices within recipient
              permissions. The project needs a working directory. Existing earlier routing rules
              retain priority. Apply, then save the connection.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                data-testid="channel-replies-apply"
                disabled={!replyProject || !replyAgent.trim()}
                onClick={() =>
                  void run(async () => {
                    const recipient = draft.targets.find((t) => t.id === replyTarget);
                    if (!recipient?.user_ids.length)
                      throw new Error("Pair this recipient or add approved sender IDs first.");
                    const rule = ChannelRouteSchema.parse({
                      id: `replies-${recipient.id}`,
                      name: `Replies to ${recipient.name}`,
                      enabled: true,
                      condition: {
                        all: [
                          { field: "kind", op: "is", value: "message" },
                          { field: "chat", op: "is", value: recipient.chat_id },
                          ...(recipient.thread_id
                            ? [{ field: "thread", op: "is", value: recipient.thread_id }]
                            : []),
                        ],
                      },
                      action: {
                        type: "agent",
                        agent: replyAgent.trim(),
                        project_id: replyProject,
                        ...(replyModel.trim() ? { model: replyModel.trim() } : {}),
                      },
                    });
                    update({
                      ...draft,
                      targets: draft.targets.map((t) =>
                        t.id === recipient.id
                          ? {
                              ...t,
                              inbound: true,
                              outbound: true,
                              attention: true,
                              project_ids: t.project_ids.length
                                ? [...new Set([...t.project_ids, replyProject])]
                                : [],
                            }
                          : t,
                      ),
                      routes: [
                        ...draft.routes.filter(
                          (r) => r.id !== rule.id && !isChannelCatchAll(r.condition),
                        ),
                        rule,
                        ...draft.routes.filter((r) => isChannelCatchAll(r.condition)),
                      ],
                    });
                    setReplyTarget(null);
                    return "Agent replies configured. Save the connection to activate them.";
                  })
                }
              >
                Apply agent replies
              </Button>
              <Button variant="ghost" onClick={() => setReplyTarget(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {target && (
          <TargetEditor
            key={target.original ?? "new"}
            value={target.value}
            projects={projects}
            onCancel={() => setTarget(null)}
            onSave={(v) => {
              if (draft.targets.some((t) => t.id === v.id && t.id !== target.original))
                throw new Error("Recipient alias already exists");
              update({
                ...draft,
                targets: [...draft.targets.filter((t) => t.id !== target.original), v],
              });
              setTarget(null);
            }}
          />
        )}
      </details>
      <details>
        <summary className="min-h-11 cursor-pointer py-3 text-sm">
          Custom commands ({shortcuts.length})
        </summary>
        <p className="mb-2 text-xs text-muted-foreground">
          Shortcuts send a configured prompt to the routed agent. Use $ARGUMENTS for command
          arguments. Telegram: /summary. Slack: /orc summary. ORC controls cannot be replaced.
        </p>
        {shortcuts.map((c) => (
          <div
            key={c.command}
            className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b border-border py-1"
          >
            <span className="min-w-0 text-sm">
              /{c.command} · {c.description}
            </span>
            <Button variant="ghost" onClick={() => setShortcut({ ...c, original: c.command })}>
              Edit /{c.command}
            </Button>
          </div>
        ))}
        {!shortcut && (
          <Button
            variant="outline"
            onClick={() =>
              setShortcut({ original: null, command: "", description: "", prompt: "" })
            }
          >
            Add custom command
          </Button>
        )}
        {shortcut && (
          <div className="space-y-2 py-3" data-testid="channel-command-editor">
            <Field label="Command name">
              <Input
                data-testid="channel-command-name"
                value={shortcut.command}
                onChange={(e) => setShortcut({ ...shortcut, command: e.target.value })}
                placeholder="summary"
              />
            </Field>
            <Field label="Command description">
              <Input
                data-testid="channel-command-description"
                value={shortcut.description}
                onChange={(e) => setShortcut({ ...shortcut, description: e.target.value })}
              />
            </Field>
            <Field label="Agent prompt">
              <textarea
                className="form-control min-h-24 w-full"
                data-testid="channel-command-prompt"
                value={shortcut.prompt}
                onChange={(e) => setShortcut({ ...shortcut, prompt: e.target.value })}
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button
                data-testid="channel-command-apply"
                onClick={() =>
                  void run(async () => {
                    const { original, ...value } = shortcut;
                    const parsed = ChannelCommandsSchema.parse([
                      ...shortcuts.filter((c) => c.command !== original),
                      value,
                    ]);
                    setShortcuts(parsed);
                    setShortcut(null);
                    return "Command applied. Save the connection to activate it.";
                  })
                }
              >
                Apply command
              </Button>
              {shortcut.original && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setShortcuts(shortcuts.filter((c) => c.command !== shortcut.original));
                    setShortcut(null);
                  }}
                >
                  Remove command
                </Button>
              )}
              <Button variant="ghost" onClick={() => setShortcut(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </details>
      <details>
        <summary className="min-h-11 cursor-pointer py-3 text-sm">
          Inbound routing ({draft.routes.length})
        </summary>
        <p className="mb-3 text-sm text-muted-foreground">
          Checked from top to bottom. The first enabled match handles the message; later rules do
          not run. Only approved senders and permitted projects can invoke an agent.
        </p>
        <ol className="divide-y divide-border" data-testid="channel-route-order">
          {draft.routes
            .filter((r) => !isChannelCatchAll(r.condition))
            .map((r, i, routes) => (
              <li key={r.id} className="min-w-0 py-3" data-testid="channel-route-row">
                <div className="flex min-w-0 items-start gap-2">
                  <span
                    className="flex size-8 shrink-0 items-center justify-center text-sm text-muted-foreground"
                    title={`Priority ${i + 1}`}
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="break-words text-sm font-medium">
                      {r.name}
                      {!r.enabled && (
                        <span className="ml-2 font-normal text-muted-foreground">
                          Disabled · skipped
                        </span>
                      )}
                    </p>
                    <p
                      className="line-clamp-2 break-words text-xs text-muted-foreground"
                      title={channelConditionSummary(r.condition)}
                    >
                      {channelConditionSummary(r.condition)}
                    </p>
                    <p className="break-words text-xs">{routeActionLabel(r, projects)}</p>
                  </div>
                  <div className="flex shrink-0 gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={i === 0}
                      aria-label={`Move ${r.name} up`}
                      onClick={() => {
                        const ordered = [...draft.routes];
                        [ordered[i - 1], ordered[i]] = [
                          ordered[i] as ChannelRoute,
                          ordered[i - 1] as ChannelRoute,
                        ];
                        update({ ...draft, routes: ordered });
                      }}
                    >
                      <ArrowUp className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={i === routes.length - 1}
                      aria-label={`Move ${r.name} down`}
                      onClick={() => {
                        const ordered = [...draft.routes];
                        [ordered[i], ordered[i + 1]] = [
                          ordered[i + 1] as ChannelRoute,
                          ordered[i] as ChannelRoute,
                        ];
                        update({ ...draft, routes: ordered });
                      }}
                    >
                      <ArrowDown className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Edit rule ${r.name}`}
                      onClick={() => setRule(r)}
                    >
                      <Pencil className="size-4" />
                    </Button>
                  </div>
                </div>
                {rule?.id === r.id && ruleEditor}
              </li>
            ))}
        </ol>
        {!draft.routes.some((r) => !isChannelCatchAll(r.condition)) && (
          <p className="py-3 text-sm text-muted-foreground">
            No conditions yet. Add a rule for messages that need a specific agent or project.
          </p>
        )}
        <Button
          variant="outline"
          className="mt-2"
          onClick={() =>
            setRule({
              id: crypto.randomUUID(),
              name: "New rule",
              enabled: true,
              condition: defaultRouteCondition,
              action: { type: "agent", agent: "default", project_id: projects[0]?.id ?? "" },
            })
          }
        >
          Add routing rule
        </Button>
        {rule &&
          !isChannelCatchAll(rule.condition) &&
          !draft.routes.some((route) => route.id === rule.id) &&
          ruleEditor}
        <div className="my-3 border-y border-border py-3" data-testid="channel-route-default">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium">Otherwise</p>
              <p className="text-xs text-muted-foreground">
                After all rules above, for any remaining authorized message.
              </p>
              <p className="break-words text-sm">
                {fallback?.enabled
                  ? routeActionLabel(fallback, projects)
                  : `${fallback ? "Default disabled. " : ""}Show setup guidance; no agent starts.`}
              </p>
            </div>
            <Button
              variant="ghost"
              onClick={() =>
                setRule(
                  draft.routes.find((r) => isChannelCatchAll(r.condition)) ?? {
                    id: crypto.randomUUID(),
                    name: "Otherwise",
                    enabled: true,
                    condition: { always: true },
                    action: { type: "ignore" },
                  },
                )
              }
            >
              {fallback ? "Edit default" : "Set default"}
            </Button>
          </div>
          {rule && isChannelCatchAll(rule.condition) && ruleEditor}
        </div>
        <p className="text-xs text-muted-foreground">
          Apply each rule, then save the connection to activate changes. Preview below uses the last
          saved rules.
        </p>
        <details className="mt-3">
          <summary className="min-h-11 cursor-pointer py-3 text-sm">
            Test saved routing without invoking an agent
          </summary>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Sender ID">
              <Input
                value={probe.sender}
                onChange={(e) => setProbe({ ...probe, sender: e.target.value })}
              />
            </Field>
            <Field label="Chat ID">
              <Input
                value={probe.chat}
                onChange={(e) => setProbe({ ...probe, chat: e.target.value })}
              />
            </Field>
            <Field label="Incoming text">
              <Input
                value={probe.text}
                onChange={(e) => setProbe({ ...probe, text: e.target.value })}
              />
            </Field>
            <div>
              <Check
                label="Direct message"
                checked={probe.is_direct}
                onChange={(v) => setProbe({ ...probe, is_direct: v })}
              />
              <Check
                label="Mentions bot"
                checked={probe.is_mention}
                onChange={(v) => setProbe({ ...probe, is_mention: v })}
              />
            </div>
          </div>
          <Button
            variant="outline"
            onClick={() =>
              void run(async () => {
                const saved = (await api.channels.list()).find(
                  (connection) => connection.id === draft.id,
                );
                const result = await api.channels.routeTest(draft.id, probe);
                const action = ChannelRouteSchema.shape.action.safeParse(result.action);
                return !result.authorized
                  ? "Sender/destination not authorized."
                  : result.route_id
                    ? (() => {
                        const matched = saved?.routes.find((route) => route.id === result.route_id);
                        return `${matched && isChannelCatchAll(matched.condition) ? "Otherwise" : `Matched ${matched?.name ?? result.route_id}`}: ${action.success ? routeActionLabel({ action: action.data }, projects) : "No action"}`;
                      })()
                    : "No rule matched. Show setup guidance; no agent starts.";
              })
            }
          >
            Preview route
          </Button>
        </details>
      </details>
    </div>
  );
}

export function ChannelSettings({ active }: { active: boolean }) {
  const channels = useQuery({
    queryKey: ["channels"],
    queryFn: api.channels.list,
    enabled: active,
    refetchInterval: active ? 15000 : false,
  });
  const providers = useQuery({
    queryKey: ["channel-providers"],
    queryFn: api.channels.providers,
    enabled: active,
  });
  const projects = useQuery({
    queryKey: ["channel-projects"],
    queryFn: () => api.projects.listAll(),
    enabled: active,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, ChannelConnection>>({});
  const [provider, setProvider] = useState<"telegram" | "slack">("telegram");
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [pending, setPending] = useState(false);
  const run = async (work: () => Promise<string>) => {
    if (pending) return;
    setPending(true);
    setError("");
    setFeedback("");
    try {
      setFeedback(await work());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Channel action failed");
    } finally {
      setPending(false);
    }
  };
  const edit = (c: ChannelView) => {
    const {
      credentials: _credentials,
      status: _status,
      identity: _identity,
      error: _error,
      ...data
    } = c;
    setDrafts((prev) => ({
      ...prev,
      [c.id]: prev[c.id] ?? ChannelConnectionSchema.parse({ ...data, credentials: {} }),
    }));
    setSelected(c.id);
  };
  return (
    <section
      aria-label="Channel settings"
      className="max-w-3xl space-y-4"
      data-testid="channel-settings"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-medium">Channels</h2>
        <div className="flex items-center gap-2">
          <select
            className="form-control form-control-single w-32 min-w-0"
            aria-label="New channel provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value as typeof provider)}
          >
            <option value="telegram">Telegram</option>
            <option value="slack">Slack</option>
          </select>
          <Button
            data-testid="channel-add"
            className="shrink-0"
            onClick={() => {
              const id = `new-${crypto.randomUUID()}`;
              setDrafts((prev) => ({
                ...prev,
                [id]: ChannelConnectionSchema.parse({
                  id: `${provider}-${Date.now()}`,
                  name: provider === "telegram" ? "Personal Telegram" : "Work Slack",
                  provider,
                }),
              }));
              setSelected(id);
            }}
          >
            Add channel
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        Send messages to approved recipients and route incoming messages to agents.
      </p>
      {(error || channels.error || providers.error) && (
        <p role="alert" className="break-words text-sm text-error">
          {error || channels.error?.message || providers.error?.message}
        </p>
      )}
      {feedback && (
        <p role="status" className="break-words text-sm">
          {feedback}
        </p>
      )}
      {channels.isPending && <p className="text-sm">Loading channels…</p>}
      <div className="divide-y divide-border">
        {channels.data?.map((c) => (
          <div key={c.id} className="py-2" data-testid={`channel-row-${c.id}`}>
            <div className="flex min-h-11 items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{c.name}</div>
                <div className="text-xs text-muted-foreground">
                  {c.provider} · {c.identity?.name ?? c.status} · {c.targets.length}{" "}
                  {c.targets.length === 1 ? "recipient" : "recipients"}
                </div>
              </div>
              <Button variant="ghost" aria-expanded={selected === c.id} onClick={() => edit(c)}>
                Edit {c.name}
              </Button>
            </div>
            {c.error && (
              <p role="alert" className="break-words text-sm text-error">
                {c.error}
              </p>
            )}
          </div>
        ))}
      </div>
      {!channels.isPending && !channels.data?.length && (
        <p className="py-3 text-sm text-muted-foreground">
          No channels configured. Add Telegram or Slack to get started.
        </p>
      )}
      <fieldset disabled={pending} className="min-w-0">
        {Object.entries(drafts).map(
          ([editorId, draft]) =>
            providers.data?.find((p) => p.id === draft.provider) && (
              <div key={editorId} hidden={selected !== editorId}>
                <ConnectionEditor
                  draft={draft}
                  provider={
                    providers.data.find((p) => p.id === draft.provider) as ChannelProviderInfo
                  }
                  projects={projects.data?.projects ?? []}
                  update={(value) => {
                    if (value.revision > 0 && value.id !== editorId) {
                      setDrafts((prev) => {
                        const { [editorId]: _previous, ...rest } = prev;
                        return { ...rest, [value.id]: value };
                      });
                      setSelected(value.id);
                    } else setDrafts((prev) => ({ ...prev, [editorId]: value }));
                  }}
                  run={run}
                  onClose={() => setSelected(null)}
                />
              </div>
            ),
        )}
      </fieldset>
    </section>
  );
}
