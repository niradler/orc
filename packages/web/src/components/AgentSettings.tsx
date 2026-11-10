import { ChatAgentOptionsSchema, chatRuntime } from "@orc/core/chat-options";
import {
  agentLabel,
  CODING_AGENTS,
  chatRuntimeFor,
  supportsManualCompaction,
  supportsModelDiscovery,
} from "@orc/core/coding-agents";
import { ulid } from "@orc/core/ids";
import {
  type ProviderProfile,
  type ProviderSettings,
  ProviderSettingsSchema,
  providerSecretName,
} from "@orc/core/providers";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import { AgentIcon } from "@/components/AgentIcon";
import { HelpPopover } from "@/components/HelpPopover";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CHAT_PREFERENCES_KEY } from "@/hooks/chat-contract";
import { PROVIDER_SETTINGS_KEY, useProviders, WORKSPACE_PREFERENCES_KEY } from "@/hooks/useAgents";

function optionsText(profile: ProviderProfile): string {
  return JSON.stringify(
    profile.options?.runtime === "claude-sdk" || profile.options?.runtime === "pi"
      ? profile.options.options
      : (profile.options?.args ??
          (["claude-sdk", "pi"].includes(chatRuntime(profile.agent)) ? {} : [])),
    null,
    2,
  );
}
export function AgentSettings() {
  const client = useQueryClient();
  const query = useProviders();
  const [draft, setDraft] = useState<ProviderSettings | null>(null);
  const [editing, setEditing] = useState("");
  const [optionDrafts, setOptionDrafts] = useState<Record<string, string>>({});
  const [optionErrors, setOptionErrors] = useState<Record<string, string>>({});
  const [environmentKeys, setEnvironmentKeys] = useState<Record<string, string[]>>({});
  const [newOpen, setNewOpen] = useState(false);
  const [name, setName] = useState("");
  const [agent, setAgent] = useState("claude");
  const [custom, setCustom] = useState("");
  const [newError, setNewError] = useState("");
  const settings = draft ?? query.data;
  const profile =
    settings?.providers.find((item) => item.id === (editing || settings.default_provider_id)) ??
    settings?.providers[0];
  const selectedButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (profile?.id)
      selectedButton.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [profile?.id]);
  const validation = settings ? ProviderSettingsSchema.safeParse(settings) : null;
  const dirty =
    !!settings &&
    (JSON.stringify(settings) !== JSON.stringify(query.data) ||
      Object.values(optionErrors).some(Boolean));
  const save = useMutation({
    mutationFn: (value: ProviderSettings) => api.settings.providers.save(value),
    onSuccess: async (saved) => {
      client.setQueryData(PROVIDER_SETTINGS_KEY, saved);
      setDraft(null);
      setOptionDrafts({});
      setOptionErrors({});
      localStorage.removeItem(CHAT_PREFERENCES_KEY);
      await client.invalidateQueries({ queryKey: WORKSPACE_PREFERENCES_KEY });
      await client.invalidateQueries({ queryKey: ["terminal-launchers"] });
      await client.invalidateQueries({ queryKey: ["terminals"] });
      await client.invalidateQueries({ queryKey: ["chat-models"] });
      window.dispatchEvent(new Event("orc-chat-settings-changed"));
    },
  });
  const busy = query.isFetching || query.isError || save.isPending;
  const quotas = useQuery({
    queryKey: ["usage-quotas"],
    queryFn: api.settings.usageQuotas,
    enabled: false,
  });
  const quota = quotas.data?.accounts.find((account) => account.provider === profile?.agent);
  const catalog = useQuery({
    queryKey: ["provider-models", profile?.id, query.data?.revision],
    queryFn: () =>
      api.chat.models(profile?.agent ?? "codex", undefined, undefined, undefined, profile?.id),
    enabled: false,
    retry: false,
  });
  function patch(change: Partial<ProviderProfile>, rowKeys?: string[]): void {
    if (!settings || !profile) return;
    const environment = change.environment;
    if (environment)
      setEnvironmentKeys((current) => ({
        ...current,
        [profile.id]:
          rowKeys ??
          environment.map(
            (_, index) =>
              current[profile.id]?.[index] ??
              profile.environment[index]?.name ??
              crypto.randomUUID(),
          ),
      }));
    save.reset();
    setDraft({
      ...settings,
      providers: settings.providers.map((item) =>
        item.id === profile.id ? { ...item, ...change } : item,
      ),
    });
  }
  function discard(): void {
    setDraft(null);
    setOptionDrafts({});
    setOptionErrors({});
    save.reset();
  }
  function create(): void {
    if (!settings) return;
    const adapter = agent === "other" ? custom.trim().toLowerCase() : agent;
    if (!name.trim() || !/^[a-z][a-z0-9-]{0,31}$/.test(adapter)) {
      setNewError("Enter a name and a valid adapter.");
      return;
    }
    if (settings.providers.some((item) => item.name.toLowerCase() === name.trim().toLowerCase())) {
      setNewError("Choose a unique provider name.");
      return;
    }
    const next: ProviderProfile = {
      id: ulid().toLowerCase(),
      name: name.trim(),
      agent: adapter,
      enabled: true,
      executable: "",
      model: "",
      environment: [],
    };
    setDraft({ ...settings, providers: [...settings.providers, next] });
    setEditing(next.id);
    setNewOpen(false);
    setName("");
    setCustom("");
    save.reset();
  }
  function changeOptions(value: string): void {
    if (!profile) return;
    setOptionDrafts((current) => ({ ...current, [profile.id]: value }));
    try {
      const raw = JSON.parse(value);
      const runtime = chatRuntime(profile.agent);
      const options = ChatAgentOptionsSchema.parse(
        runtime === "claude-sdk" || runtime === "pi"
          ? { runtime, options: raw }
          : { runtime, args: raw },
      );
      patch({ options });
      setOptionErrors((current) => ({ ...current, [profile.id]: "" }));
    } catch {
      setOptionErrors((current) => ({
        ...current,
        [profile.id]: "Enter valid JSON with supported options for this adapter.",
      }));
    }
  }
  return (
    <section aria-labelledby="agent-settings-title" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-1">
          <h2 id="agent-settings-title" className="text-base font-medium">
            Coding providers{" "}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {settings?.providers.filter((item) => item.enabled).length ?? 0} enabled
            </span>
          </h2>
          <HelpPopover label="Coding providers" testId="provider-help">
            Named configurations for coding agents. Existing conversations keep their selected
            provider.
          </HelpPopover>
        </div>
        <Button
          variant="outline"
          data-testid="provider-new"
          disabled={busy || (settings?.providers.length ?? 0) >= 64}
          onClick={() => {
            setNewError("");
            setNewOpen(true);
          }}
        >
          <Plus size={14} />
          New provider
        </Button>
      </div>
      {query.isPending && <p role="status">Loading providers...</p>}
      {query.error && (
        <div role="alert">
          <p>Providers could not be loaded.</p>
          <Button variant="ghost" onClick={() => void query.refetch()}>
            Retry
          </Button>
        </div>
      )}
      {settings && !settings.providers.some((item) => item.enabled) && (
        <p
          role="status"
          data-testid="provider-none-enabled"
          className="text-sm text-muted-foreground"
        >
          No coding providers enabled. Install an agent, then enable it here.
        </p>
      )}
      {settings && (
        <div className="grid items-center gap-2 sm:grid-cols-[140px_minmax(0,1fr)]">
          <Label htmlFor="provider-default">Default provider</Label>
          <select
            id="provider-default"
            data-testid="provider-default"
            className="form-control form-control-single"
            disabled={busy}
            value={settings.default_provider_id}
            onChange={(event) => {
              save.reset();
              setDraft({ ...settings, default_provider_id: event.target.value });
            }}
          >
            {settings.providers.map((item) => (
              <option key={item.id} value={item.id} disabled={!item.enabled}>
                {item.name}
                {item.enabled ? "" : " (disabled)"}
              </option>
            ))}
          </select>
        </div>
      )}
      {settings && profile && (
        <div className="grid min-w-0 overflow-hidden rounded-md border border-border lg:grid-cols-[220px_minmax(0,1fr)]">
          <nav
            aria-label="Coding providers"
            className="flex overflow-x-auto border-b border-border lg:block lg:max-h-[36rem] lg:overflow-y-auto lg:divide-y lg:divide-border lg:border-r lg:border-b-0"
          >
            {settings.providers.map((item) => (
              <div
                key={item.id}
                className={
                  "flex min-h-11 shrink-0 items-center gap-2 px-3 lg:min-w-0 " +
                  (profile.id === item.id ? "bg-surface-highest" : "")
                }
              >
                <button
                  type="button"
                  data-testid={`provider-select-${item.id}`}
                  ref={profile.id === item.id ? selectedButton : undefined}
                  title={item.name}
                  aria-pressed={profile.id === item.id}
                  onClick={() => setEditing(item.id)}
                  className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <AgentIcon agent={item.agent} decorative size={16} />
                  <span className="min-w-0 truncate text-sm">{item.name}</span>
                </button>
                <label className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center">
                  <input
                    type="checkbox"
                    className="accent-primary"
                    aria-label={`Enable ${item.name}`}
                    data-testid={`agent-enabled-${item.id}`}
                    checked={item.enabled}
                    disabled={busy}
                    onChange={(event) => {
                      save.reset();
                      setDraft({
                        ...settings,
                        providers: settings.providers.map((entry) =>
                          entry.id === item.id
                            ? { ...entry, enabled: event.target.checked }
                            : entry,
                        ),
                      });
                    }}
                  />
                </label>
              </div>
            ))}
          </nav>
          <div data-testid="provider-editor" className="min-w-0 space-y-4 p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="provider-name">Name</Label>
                <Input
                  id="provider-name"
                  data-testid="provider-name"
                  maxLength={80}
                  value={profile.name}
                  disabled={busy}
                  onChange={(event) => patch({ name: event.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>Adapter</Label>
                <p className="flex min-h-8 items-center gap-2 text-sm">
                  <AgentIcon agent={profile.agent} decorative size={16} />
                  {agentLabel(profile.agent)}
                  <span className="text-xs text-muted-foreground">
                    {supportsManualCompaction(profile.agent)
                      ? "native"
                      : chatRuntimeFor(profile.agent) === "opencode"
                        ? "acp"
                        : "acpx"}
                  </span>
                </p>
              </div>
            </div>
            {["claude", "codex", "opencode", "pi"].includes(profile.agent) && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1">
                    <Label htmlFor="provider-binary">Executable path</Label>
                    <HelpPopover label="Executable path" testId="provider-binary-help">
                      Optional local binary path, without arguments. Blank uses the default
                      installation. SSH uses its remote installation.
                    </HelpPopover>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid="provider-use-default"
                    disabled={busy || !profile.executable}
                    onClick={() => patch({ executable: "" })}
                  >
                    Use default
                  </Button>
                </div>
                <Input
                  id="provider-binary"
                  data-testid="provider-binary"
                  value={profile.executable}
                  maxLength={2048}
                  placeholder={profile.agent}
                  disabled={busy}
                  onChange={(event) => patch({ executable: event.target.value })}
                />
              </div>
            )}
            <div className="space-y-2">
              <div className="flex items-center gap-1">
                <Label htmlFor="provider-model">Default model</Label>
                <HelpPopover label="Default model" testId="provider-model-help">
                  Leave blank for the adapter default. Explicit session models take precedence. Save
                  connection changes before loading model choices.
                </HelpPopover>
              </div>
              <Input
                id="provider-model"
                data-testid="provider-model"
                value={profile.model}
                placeholder="Adapter default"
                list="provider-model-choices"
                disabled={busy}
                onFocus={() => {
                  if (!dirty && supportsModelDiscovery(profile.agent)) void catalog.refetch();
                }}
                onChange={(event) => patch({ model: event.target.value })}
              />
              <datalist id="provider-model-choices">
                {catalog.data?.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </datalist>
              {(catalog.data?.warning || catalog.isError) && (
                <p role="status" className="text-xs text-muted-foreground">
                  {catalog.data?.warning ?? "Models could not be loaded. Enter a custom model ID."}
                </p>
              )}
            </div>
            <details
              key={profile.id}
              data-testid="provider-advanced"
              className="space-y-3 border-t border-border pt-3"
            >
              <summary className="min-h-11 cursor-pointer text-sm">
                Advanced configuration{" "}
                <span className="ml-1 text-xs text-muted-foreground">
                  {profile.environment.length ? `${profile.environment.length} variables` : ""}
                </span>
              </summary>
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-1">
                    <Label>Environment overrides</Label>
                    <HelpPopover label="Environment overrides" testId="provider-env-help">
                      Applies to launches and model discovery. Empty values clear inherited values.
                      Credential variables are encrypted and write-only. Leave a saved secret
                      untouched to preserve it; enter a value to replace it.
                    </HelpPopover>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="provider-env-add"
                    disabled={busy || profile.environment.length >= 64}
                    onClick={() =>
                      patch({
                        environment: [
                          ...profile.environment,
                          { name: "", value: "", secret: false },
                        ],
                      })
                    }
                  >
                    <Plus size={14} />
                    Add variable
                  </Button>
                </div>
                {profile.environment.map((row, index) => (
                  <div
                    key={environmentKeys[profile.id]?.[index] ?? row.name}
                    data-testid="provider-env-row"
                    className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 border-b border-border py-2"
                  >
                    <Input
                      aria-label="Variable name"
                      data-testid="provider-env-name"
                      value={row.name}
                      placeholder="VARIABLE_NAME"
                      maxLength={128}
                      disabled={busy || row.value === null}
                      className="font-mono text-xs"
                      onChange={(event) =>
                        patch({
                          environment: profile.environment.map((item, number) =>
                            number === index
                              ? {
                                  ...item,
                                  name: event.target.value,
                                  secret: item.secret || providerSecretName(event.target.value),
                                }
                              : item,
                          ),
                        })
                      }
                    />
                    <label className="flex min-h-11 items-center gap-1 text-xs">
                      <input
                        type="checkbox"
                        checked={row.secret}
                        disabled={busy || providerSecretName(row.name) || row.value === null}
                        onChange={(event) =>
                          patch({
                            environment: profile.environment.map((item, number) =>
                              number === index ? { ...item, secret: event.target.checked } : item,
                            ),
                          })
                        }
                      />
                      Secret
                    </label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove variable ${row.name}`}
                      disabled={busy}
                      onClick={() =>
                        patch(
                          {
                            environment: profile.environment.filter(
                              (_, number) => number !== index,
                            ),
                          },
                          profile.environment
                            .map(
                              (item, number) => environmentKeys[profile.id]?.[number] ?? item.name,
                            )
                            .filter((_, number) => number !== index),
                        )
                      }
                    >
                      <X size={14} />
                    </Button>
                    <Input
                      aria-label={`Value for ${row.name || "variable"}`}
                      data-testid="provider-env-value"
                      type={row.secret ? "password" : "text"}
                      autoComplete="off"
                      value={row.value ?? ""}
                      placeholder={
                        row.value === null
                          ? "Saved secret - enter to replace"
                          : "Value (can be empty)"
                      }
                      maxLength={8192}
                      disabled={busy}
                      className="col-span-3"
                      onChange={(event) =>
                        patch({
                          environment: profile.environment.map((item, number) =>
                            number === index ? { ...item, value: event.target.value } : item,
                          ),
                        })
                      }
                    />
                  </div>
                ))}
              </div>
              <div className="space-y-2 border-t border-border pt-3">
                <div className="flex items-center gap-1">
                  <Label htmlFor={profile.agent === "opencode" ? undefined : "provider-options"}>
                    {profile.agent === "opencode"
                      ? "OpenCode configuration"
                      : "Chat launch options (JSON)"}
                  </Label>
                  <HelpPopover
                    label={
                      profile.agent === "opencode"
                        ? "OpenCode configuration"
                        : "Chat launch options"
                    }
                    testId="provider-options-help"
                  >
                    {profile.agent === "opencode"
                      ? "Configure custom providers and model options in OpenCode on the execution host. Use Default model above for a provider/model override, or leave it blank for OpenCode's default. Environment overrides apply to ACP and model discovery. ACPX launch flags do not apply to OpenCode."
                      : chatRuntime(profile.agent) === "claude-sdk"
                        ? 'Claude SDK options, for example {"effort":"high","maxTurns":20}.'
                        : chatRuntime(profile.agent) === "pi"
                          ? 'Pi options, for example {"thinkingLevel":"high","autoCompaction":true}.'
                          : chatRuntime(profile.agent) === "codex"
                            ? 'Codex arguments, for example ["-c","model_reasoning_effort=\\"high\\""].'
                            : 'ACPX arguments, for example ["--timeout","120"].'}{" "}
                    Session options override these defaults. These options apply to chat, not native
                    terminal launches.
                  </HelpPopover>
                </div>
                {profile.agent !== "opencode" && (
                  <Textarea
                    id="provider-options"
                    data-testid="provider-options"
                    rows={4}
                    maxLength={20000}
                    className="font-mono text-xs"
                    disabled={busy}
                    value={optionDrafts[profile.id] ?? optionsText(profile)}
                    onChange={(event) => changeOptions(event.target.value)}
                  />
                )}
                {optionErrors[profile.id] && (
                  <p role="alert" className="text-xs text-error">
                    {optionErrors[profile.id]}
                  </p>
                )}
              </div>
            </details>
            <div className="flex items-center gap-1 border-t border-border pt-3">
              <h3 className="text-sm font-medium">Context compaction</h3>
              <HelpPopover label="Context compaction" testId="provider-compact-help">
                {supportsManualCompaction(profile.agent)
                  ? "Compact an idle conversation from its actions or send /compact. Automatic compaction stays under the agent's control."
                  : "Manual compaction is not available through this adapter."}
              </HelpPopover>
            </div>
            {["claude", "codex"].includes(profile.agent) && (
              <details className="space-y-2 border-t border-border pt-3">
                <summary className="min-h-11 cursor-pointer text-sm">Local account limits</summary>
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={quotas.isFetching}
                    onClick={() => void quotas.refetch()}
                  >
                    {quotas.isFetching ? "Checking..." : "Check limits"}
                  </Button>
                  <HelpPopover label="Local account limits" testId="provider-limits-help">
                    Local CLI account only. Gateway, Bedrock billing and SSH quotas are not
                    included.
                  </HelpPopover>
                </div>
                {quotas.isError && <p role="alert">Limits could not be loaded. Try again.</p>}
                {quota && (
                  <div data-testid="provider-limits" className="space-y-2 text-xs">
                    <p>Checked {new Date(quota.checked_at).toLocaleTimeString()}</p>
                    {quota.status !== "available" && (
                      <p>{quota.message ?? "Account limits are unavailable."}</p>
                    )}
                    {quota.windows.map((window) => (
                      <p key={window.label}>
                        {window.label}: {window.used_percent}% used
                        {window.resets_at
                          ? ` - Resets ${new Date(window.resets_at).toLocaleString()}`
                          : " - Reset time unavailable"}
                      </p>
                    ))}
                  </div>
                )}
              </details>
            )}
          </div>
        </div>
      )}
      {validation && !validation.success && dirty && (
        <p role="alert" data-testid="provider-validation" className="text-sm text-error">
          {[...new Set(validation.error.issues.map((issue) => issue.message))].join(" ")}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          data-testid="agent-settings-save"
          disabled={
            busy || !dirty || !validation?.success || Object.values(optionErrors).some(Boolean)
          }
          onClick={() => {
            if (settings) save.mutate(settings);
          }}
        >
          {save.isPending ? "Saving..." : "Save changes"}
        </Button>
        {dirty && (
          <Button
            variant="ghost"
            data-testid="provider-discard"
            disabled={save.isPending}
            onClick={discard}
          >
            Discard changes
          </Button>
        )}
        {save.isSuccess && (
          <p role="status" data-testid="agent-settings-saved">
            Provider settings saved.
          </p>
        )}
        {save.error && (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-error">
              {save.error.message}
            </p>
            <Button
              variant="outline"
              onClick={() => {
                discard();
                void query.refetch();
              }}
            >
              Discard draft and reload
            </Button>
          </div>
        )}
      </div>
      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent>
          <div className="flex items-center gap-1">
            <DialogTitle>New provider</DialogTitle>
            <HelpPopover label="New provider" testId="provider-new-help">
              Choose a coding-agent adapter, then configure its models and environment.
            </HelpPopover>
          </div>
          <DialogDescription className="sr-only">
            Choose a coding-agent adapter, then configure its models and environment.
          </DialogDescription>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="provider-new-name">Provider name</Label>
              <Input
                id="provider-new-name"
                data-testid="provider-new-name"
                value={name}
                placeholder="e.g. Claude LiteLLM"
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="provider-new-adapter">Adapter</Label>
              <select
                id="provider-new-adapter"
                data-testid="provider-new-adapter"
                className="form-control form-control-single"
                value={agent}
                onChange={(event) => setAgent(event.target.value)}
              >
                {CODING_AGENTS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                    {supportsManualCompaction(item.id)
                      ? ""
                      : chatRuntimeFor(item.id) === "opencode"
                        ? " (acp)"
                        : " (acpx)"}
                  </option>
                ))}
                <option value="other">Other acpx agent</option>
              </select>
            </div>
            {agent === "other" && (
              <div className="space-y-2">
                <Label htmlFor="provider-custom-agent">acpx agent ID</Label>
                <Input
                  id="provider-custom-agent"
                  data-testid="agent-custom"
                  value={custom}
                  placeholder="e.g. qoder"
                  onChange={(event) => setCustom(event.target.value)}
                />
              </div>
            )}
            {newError && <p role="alert">{newError}</p>}
            <Button data-testid="provider-create" disabled={!name.trim()} onClick={create}>
              Configure provider
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
