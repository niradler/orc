import { Check, Copy } from "lucide-react";
import { type ReactNode, useState } from "react";
import { agentDisplayName } from "@/components/AgentIcon";
import { ChatAgentOptionsEditor } from "@/components/ChatAgentOptionsEditor";
import { ChatPermissionSelect } from "@/components/ChatPermissionSelect";
import { ChatSendModeSelect } from "@/components/ChatSendModeSelect";
import { HelpPopover } from "@/components/HelpPopover";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAgentCapabilities } from "@/hooks/useAgentCapabilities";
import { useChat } from "@/hooks/useChat";
import { useDesktopPreview } from "@/lib/desktop-preview-context";
import { THIS_SERVER } from "@/lib/host-labels";

/** The conversation's own settings: identity, capabilities, permissions and instructions. */
export function ChatConversationInfo({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { config, changePermissions, changeSendMode, thread } = useChat();
  const preview = useDesktopPreview();
  const capabilities = useAgentCapabilities(config.agent, thread);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="chat-config-dialog"
        tabIndex={-1}
        onOpenAutoFocus={(event) => {
          // Do not focus a help trigger: its tooltip would become the top layer
          // and swallow the Escape that closes the dialog.
          event.preventDefault();
          const content = event.currentTarget as HTMLElement | null;
          content?.focus();
        }}
        className="w-[calc(100%-1rem)] min-w-0 grid-cols-[minmax(0,1fr)] sm:max-w-2xl"
      >
        <div className="flex min-w-0 items-center gap-1 pr-8">
          <DialogTitle className="min-w-0 flex-1">Session settings</DialogTitle>
          <HelpPopover label="Session settings">
            These settings belong to this conversation. Loosening permissions applies right away,
            including to a pending approval; stricter permissions apply to your next message. New
            chat defaults live in Settings → Agents → Chat.
          </HelpPopover>
        </div>
        <DialogDescription className="sr-only">
          Information and customization for this chat session.
        </DialogDescription>
        <Tabs defaultValue="overview" className="min-w-0">
          <TabsList aria-label="Session settings sections" className="grid w-full grid-cols-2 p-0">
            {(
              [
                ["overview", "Overview"],
                ["customize", "Customize"],
              ] as const
            ).map(([value, label]) => (
              <TabsTrigger
                key={value}
                value={value}
                data-testid={`chat-settings-tab-${value}`}
                className="bg-surface hover:bg-surface-high"
              >
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="overview" className="space-y-4">
            <dl data-testid="chat-session-info" className="space-y-3 text-sm wrap-break-word">
              <SettingsRow label="Agent">
                <span data-testid="chat-settings-agent">{agentDisplayName(config.agent)}</span>
                {config.model && (
                  <span data-testid="chat-settings-model" className="text-muted-foreground">
                    {" "}
                    · {config.model}
                  </span>
                )}
              </SettingsRow>
              <SettingsRow label="Execution">
                {thread
                  ? `${thread.host || THIS_SERVER} · ${thread.cwd}`
                  : "Starts with your first message"}
                {thread?.cwd && (
                  <span className="block font-mono text-xs break-all">{thread.cwd}</span>
                )}
              </SettingsRow>
              {thread?.backend && (
                <SettingsRow label="Backend">
                  <span className="font-mono text-xs">{thread.backend}</span>
                </SettingsRow>
              )}
              {thread && <SettingsRow label="Last activity">{when(thread.updatedAt)}</SettingsRow>}
              <SettingsRow label="Tools">
                {config.mcp === "orc"
                  ? "ORC MCP connection plus agent host configuration"
                  : "Agent host configuration"}
              </SettingsRow>
              {capabilities && (
                <SettingsRow label="Capabilities">
                  <span data-testid="chat-capabilities">
                    {[
                      capabilities.resume && "Resume",
                      capabilities.approvals && "Approvals in chat",
                      capabilities.questions && "Questions",
                      capabilities.steering && "Steering",
                      capabilities.interrupt && "Native stop",
                      capabilities.subagents && "Subagents",
                    ]
                      .filter(Boolean)
                      .join(" · ") || "Basic text conversation"}
                  </span>
                </SettingsRow>
              )}
            </dl>
            <section aria-labelledby="chat-session-ids-heading" className="space-y-2">
              <div className="flex items-center gap-1">
                <h3 id="chat-session-ids-heading" className="text-sm font-medium">
                  Identifiers
                </h3>
                <HelpPopover label="Session identifiers" testId="chat-session-ids-help">
                  ORC chat ID names this conversation. The agent session ID is the coding agent's
                  native session, used to resume outside ORC; the resume ID is the ORC session it
                  continues.
                </HelpPopover>
              </div>
              <dl className="space-y-2" data-testid="chat-session-ids">
                <IdRow id="orc" label="ORC chat ID" value={thread?.id} empty="Not saved yet" />
                <IdRow
                  id="agent"
                  label="Agent session ID"
                  value={thread?.runtimeId}
                  empty="No native session yet"
                />
                <IdRow
                  id="resume"
                  label="Resume session ID"
                  value={thread?.sourceId}
                  empty="Not resumed from a session"
                />
              </dl>
            </section>
          </TabsContent>
          <TabsContent value="customize" className="space-y-5">
            {thread && (
              <p className="text-sm text-muted-foreground wrap-break-word">
                Runs in {thread.host || THIS_SERVER} ·{" "}
                <span className="font-mono text-xs">{thread.cwd}</span>
              </p>
            )}
            <ChatPermissionSelect
              config={config}
              onChange={(next) => void changePermissions(next)}
            />
            <ChatSendModeSelect
              config={config}
              thread={thread}
              onChange={(next) => void changeSendMode(next.sendWhileRunning)}
            />
            <ChatAgentOptionsEditor key={`${config.agent}:${thread?.id ?? "new"}`} />
            <div className="text-sm">
              <div className="flex items-center gap-1">
                <label htmlFor="chat-session-instructions" className="text-sm font-medium">
                  Session instructions
                </label>
                <HelpPopover label="Session instructions" testId="chat-instructions-help">
                  {config.agent === "claude"
                    ? "Appended to Claude’s coding system prompt."
                    : "Sent as turn instructions to the agent."}{" "}
                  Agent and workspace instructions may also apply.
                </HelpPopover>
              </div>
              <pre
                id="chat-session-instructions"
                className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background p-2 text-xs wrap-break-word"
              >
                {config.system || "No additional instructions"}
              </pre>
            </div>
            {preview && (
              <div className="border-t border-border pt-4">
                <div className="flex items-start justify-between gap-6">
                  <div className="flex min-w-0 items-center gap-1">
                    <label htmlFor="chat-browser-agent-access" className="text-sm font-medium">
                      Allow agent browser control
                    </label>
                    <HelpPopover label="Agent browser control" testId="chat-browser-help">
                      {preview.browserControl.globallyEnabled
                        ? "Agents in this chat can read, screenshot and interact with its browser, including signed-in pages. Changes apply immediately."
                        : "Disabled globally in Settings → General → Browser. Enable global access there first."}
                    </HelpPopover>
                  </div>
                  <input
                    type="checkbox"
                    id="chat-browser-agent-access"
                    data-testid="chat-browser-agent-access"
                    className="mt-1 h-4 w-4 shrink-0"
                    checked={preview.browserControl.enabled}
                    disabled={
                      preview.browserControl.pending || !preview.browserControl.globallyEnabled
                    }
                    onChange={(event) => preview.browserControl.setEnabled(event.target.checked)}
                  />
                </div>
                {preview.browserControl.error && (
                  <p
                    role="alert"
                    data-testid="chat-browser-preferences-error"
                    className="mt-2 text-xs text-error"
                  >
                    {preview.browserControl.error}
                  </p>
                )}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function SettingsRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function IdRow({
  id,
  label,
  value,
  empty,
}: {
  id: string;
  label: string;
  value: string | null | undefined;
  empty: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 items-start gap-2">
      <div className="min-w-0 flex-1">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd
          data-testid={`chat-session-id-${id}`}
          className="font-mono text-xs break-all text-on-surface-variant"
        >
          {value ?? empty}
        </dd>
      </div>
      {value && (
        <button
          type="button"
          data-testid={`chat-session-id-copy-${id}`}
          aria-label={copied ? `${label} copied` : `Copy ${label}`}
          title={copied ? `${label} copied` : `Copy ${label}`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              /* The value stays visible for manual copying. */
            }
          }}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-highest hover:text-on-surface focus-visible:outline-2 focus-visible:outline-focus max-sm:size-11 pointer-coarse:size-11"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      )}
    </div>
  );
}

function when(value: number | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}
