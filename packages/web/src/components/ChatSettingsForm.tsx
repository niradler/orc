import { type ChatSettings, ChatSettingsSchema } from "@orc/core/chat";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import { ChatPermissionSelect } from "@/components/ChatPermissionSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export function ChatSettingsForm() {
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
      const chat = ChatSettingsSchema.parse({ ...config, models: entries });
      await api.settings.save({ chat });
      setConfig(chat);
      window.dispatchEvent(new Event("orc-chat-settings-changed"));
      setFeedback("Chat defaults saved. They apply to new conversations on every device.");
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
      <div>
        <h2 id="chat-settings-title" className="text-base font-medium">
          Chat
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Defaults for new conversations. Existing chats keep their configuration. Credentials stay
          on the execution host.
        </p>
      </div>
      {config && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="chat-default-agent">Default agent</Label>
              <Input
                id="chat-default-agent"
                data-testid="chat-default-agent"
                value={config.agent}
                onChange={(e) => setConfig({ ...config, agent: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="chat-default-model">Default model</Label>
              <Input
                id="chat-default-model"
                data-testid="chat-default-model"
                value={config.model}
                placeholder="Agent default"
                onChange={(e) => setConfig({ ...config, model: e.target.value })}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="chat-model-catalog">Model picker choices</Label>
            <Textarea
              id="chat-model-catalog"
              data-testid="chat-model-catalog"
              value={models}
              onChange={(e) => setModels(e.target.value)}
              placeholder={"codex: your-model-id\nclaude: your-model-id"}
            />
            <p className="text-xs text-muted-foreground">
              One agent: model-id per line. Use model IDs supported by your installed agent and
              account.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="chat-system-prompt">Instructions</Label>
            <Textarea
              id="chat-system-prompt"
              data-testid="chat-system-prompt"
              rows={6}
              value={config.system}
              onChange={(e) => setConfig({ ...config, system: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              Claude appends these to its coding system prompt. Codex and other agents receive them
              as turn instructions. Workspace rules remain enforced.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="chat-mcp">Tools connection</Label>
            <select
              id="chat-mcp"
              data-testid="chat-mcp"
              className="min-h-11 w-full rounded-md border border-control-border bg-background px-3 text-base sm:text-sm"
              value={config.mcp}
              onChange={(e) => setConfig({ ...config, mcp: e.target.value as ChatSettings["mcp"] })}
            >
              <option value="orc">Connect ORC MCP (Claude and Codex)</option>
              <option value="native">Use the agent’s host configuration</option>
            </select>
            <p className="text-xs text-muted-foreground">
              The ORC connection uses server credentials internally and serves meta tools that
              search, describe and invoke every ORC tool on demand. Host configuration may include
              other MCP servers; this setting does not disable them. Protected workspaces may also
              require ORC tools.
            </p>
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
