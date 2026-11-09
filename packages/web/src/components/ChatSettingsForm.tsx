import { type ChatSettings, ChatSettingsSchema } from "@orc/core/chat";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import { ChatPermissionSelect } from "@/components/ChatPermissionSelect";
import { HelpPopover } from "@/components/HelpPopover";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function ChatSettingsForm({ onManageProviders }: { onManageProviders: () => void }) {
  const [config, setConfig] = useState<ChatSettings | null>(null);
  const [models, setModels] = useState("");
  const [feedback, setFeedback] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let disposed = false;
    void api.settings
      .get()
      .then((preferences) => {
        if (disposed) return;
        const saved = ChatSettingsSchema.parse(preferences.chat ?? {});
        setConfig(saved);
        setModels(saved.models.map((model) => `${model.agent}: ${model.id}`).join("\n"));
      })
      .catch((error) => {
        if (!disposed) setFeedback(error.message);
      });
    return () => {
      disposed = true;
    };
  }, []);
  async function save() {
    if (!config) return;
    setPending(true);
    setFeedback("");
    try {
      const entries = models
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          const match = line.match(/^([a-z][a-z0-9-]*):\s*(.+)$/i);
          if (!match) throw new Error("Use agent: model-id on each model line.");
          return { agent: match[1] ?? "", id: match[2] ?? "" };
        });
      const latest = ChatSettingsSchema.parse((await api.settings.get()).chat ?? {});
      const chat = ChatSettingsSchema.parse({
        ...config,
        agent: latest.agent,
        providerId: latest.providerId,
        model: latest.model,
        models: entries,
      });
      await api.settings.save({ chat });
      setConfig(chat);
      window.dispatchEvent(new Event("orc-chat-settings-changed"));
      setFeedback("Chat defaults saved. They apply to new sessions on every device.");
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Chat settings could not be saved.");
    } finally {
      setPending(false);
    }
  }
  return (
    <section
      aria-labelledby="chat-settings-title"
      className="space-y-4"
      data-testid="chat-settings"
    >
      <div className="flex items-center gap-1">
        <h2 id="chat-settings-title" className="text-base font-medium">
          Chat
        </h2>
        <HelpPopover label="Chat defaults" testId="chat-defaults-help">
          Defaults for new sessions. Existing chats keep their configuration. Credentials stay on
          the execution host or in encrypted provider settings.
        </HelpPopover>
      </div>
      {config && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3">
            <span className="text-sm">Provider and model defaults</span>
            <Button variant="outline" onClick={onManageProviders}>
              Manage providers
            </Button>
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-1">
              <Label htmlFor="chat-model-catalog">Model picker choices</Label>
              <HelpPopover label="Model picker choices" testId="chat-model-catalog-help">
                One agent: model-id per line. Use model IDs supported by your installed agent and
                account.
              </HelpPopover>
            </div>
            <Textarea
              id="chat-model-catalog"
              data-testid="chat-model-catalog"
              value={models}
              onChange={(e) => setModels(e.target.value)}
              placeholder={"codex: your-model-id\nclaude: your-model-id"}
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-1">
              <Label htmlFor="chat-system-prompt">Instructions</Label>
              <HelpPopover label="Chat instructions" testId="chat-system-help">
                Claude appends these to its coding system prompt. Codex and other agents receive
                them as turn instructions. Workspace rules remain enforced.
              </HelpPopover>
            </div>
            <Textarea
              id="chat-system-prompt"
              data-testid="chat-system-prompt"
              rows={6}
              value={config.system}
              onChange={(e) => setConfig({ ...config, system: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-1">
              <Label htmlFor="chat-mcp">Tools connection</Label>
              <HelpPopover label="Tools connection" testId="chat-mcp-help">
                The ORC connection uses server credentials internally and serves meta tools that
                search, describe and invoke every ORC tool on demand. Host configuration may include
                other MCP servers; this setting does not disable them. Protected workspaces may also
                require ORC tools.
              </HelpPopover>
            </div>
            <select
              id="chat-mcp"
              data-testid="chat-mcp"
              className="min-h-11 w-full rounded-md border border-control-border bg-background px-3 text-base sm:text-sm"
              value={config.mcp}
              onChange={(e) => setConfig({ ...config, mcp: e.target.value as ChatSettings["mcp"] })}
            >
              <option value="orc">Connect ORC MCP</option>
              <option value="native">Use the agent’s host configuration</option>
            </select>
          </div>
          <ChatPermissionSelect config={config} onChange={setConfig} disabled={pending} />
          <Button data-testid="chat-settings-save" disabled={pending} onClick={() => void save()}>
            {pending ? "Saving…" : "Save chat defaults"}
          </Button>
        </>
      )}
      {feedback && (
        <p
          role="status"
          data-testid="chat-settings-feedback"
          className="wrap-break-word text-sm text-muted-foreground"
        >
          {feedback}
        </p>
      )}
    </section>
  );
}
