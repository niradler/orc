import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle, Save } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "@/api/client";
import { AboutSettings } from "@/components/AboutSettings";
import { AgentSettings } from "@/components/AgentSettings";
import { AttentionSettings } from "@/components/AttentionSettings";
import { BrowserSettings } from "@/components/BrowserSettings";
import { ChannelSettings } from "@/components/ChannelSettings";
import { ChatSettingsForm } from "@/components/ChatSettingsForm";
import { HostsSettings } from "@/components/HostsSettings";
import { IntegrationsSettings } from "@/components/IntegrationsSettings";
import { KnowledgeSettings } from "@/components/kb/KnowledgeSettings";
import { McpSettingsForm } from "@/components/McpSettingsForm";
import { NotificationSettings } from "@/components/NotificationSettings";
import { RetentionSettings } from "@/components/RetentionSettings";
import { SecuritySettings } from "@/components/SecuritySettings";
import { ServerSettings } from "@/components/ServerSettings";
import { SettingsList, SettingsSidebar } from "@/components/SettingsNav";
import { UsageSettings } from "@/components/UsageSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ViewHeader } from "@/components/ViewHeader";
import { useBreakpoint } from "@/hooks/useMediaQuery";
import { desktopBridge } from "@/lib/desktop-bridge";
import {
  AGENT_TABS,
  type AgentTab,
  CONNECTION_TABS,
  type ConnectionTab,
  resolveSettingsTarget,
  SETTINGS_GROUP_IDS,
  SETTINGS_GROUPS,
  type SettingsGroupId,
} from "@/lib/settings-navigation";
import { TERMINAL_FONT_KEY } from "@/lib/terminal-runtime";
import { FONT_SIZES, setFontSize, setTheme, useFontSize, useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useViewParam } from "@/lib/view-params";

const agentTabLabels: Record<AgentTab, string> = {
  providers: "Providers",
  chat: "Chat",
  mcp: "MCP",
};

const connectionTabLabels: Record<ConnectionTab, string> = {
  channels: "Channels",
  integrations: "Integrations",
};

export default function Settings() {
  const phone = !useBreakpoint("md");
  const [params] = useSearchParams();
  const rawSection = params.get("settingsSection");
  const target = resolveSettingsTarget(rawSection);
  const [, setSection] = useViewParam<SettingsGroupId | "">(
    "settingsSection",
    "",
    SETTINGS_GROUP_IDS,
  );
  const [agentTab, setAgentTab] = useViewParam<AgentTab>(
    "agentsTab",
    target?.agentTab ?? "providers",
    AGENT_TABS,
  );
  const [connectionTab, setConnectionTab] = useViewParam<ConnectionTab>(
    "connectionsTab",
    target?.connectionTab ?? "channels",
    CONNECTION_TABS,
  );
  // A phone opens the section list first; deep links and desktop open a panel directly.
  const activeGroup: SettingsGroupId | null =
    target?.group ?? (phone && rawSection === null ? null : "general");
  const activeGroupMeta = SETTINGS_GROUPS.find((group) => group.id === activeGroup);
  const panelVisible = activeGroup !== null;
  // Panels mount on first visit and then stay mounted, so drafts survive switching
  // without loading every settings section behind the phone list.
  const [visited, setVisited] = useState<ReadonlySet<SettingsGroupId>>(
    () => new Set(activeGroup ? [activeGroup] : []),
  );
  const mounted = (id: SettingsGroupId) => visited.has(id) || id === activeGroup;

  const { theme } = useTheme();
  const fontSize = useFontSize();
  const [terminalFont, setTerminalFont] = useState(
    () => localStorage.getItem(TERMINAL_FONT_KEY) ?? "",
  );
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const qc = useQueryClient();
  const rootRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: moving between the phone list and a panel resets its scroll
  useEffect(() => {
    if (!phone) return;
    const scroller = rootRef.current?.closest("main") as HTMLElement | null;
    scroller?.scrollTo({ top: 0 });
  }, [phone, activeGroup]);

  // Deep links and browser history can select a group without a click.
  useEffect(() => {
    if (!activeGroup) return;
    setVisited((current) =>
      current.has(activeGroup) ? current : new Set(current).add(activeGroup),
    );
  }, [activeGroup]);

  function openSection(value: SettingsGroupId) {
    setVisited((current) => (current.has(value) ? current : new Set(current).add(value)));
    setSection(value);
    setError("");
    setFeedback("");
  }

  function backToList() {
    setSection("", { replace: true });
    setError("");
    setFeedback("");
  }

  async function saveTerminal(reset = false) {
    setError("");
    setFeedback("");
    setPending(true);
    try {
      const preferences = await api.settings.save({
        terminal_font: reset ? "" : terminalFont.trim(),
      });
      const font = preferences.terminal_font ?? "";
      setTerminalFont(font);
      if (font) localStorage.setItem(TERMINAL_FONT_KEY, font);
      else localStorage.removeItem(TERMINAL_FONT_KEY);
      setFeedback(
        reset
          ? "Terminal font restored to its default."
          : "Terminal font saved. New terminals use this font.",
      );
      await qc.invalidateQueries();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Settings could not be saved.");
    } finally {
      setPending(false);
    }
  }

  async function changeTheme(value: "dark" | "light") {
    setError("");
    setFeedback("");
    setPending(true);
    try {
      const preferences = await api.settings.save({ theme: value });
      setTheme(preferences.theme ?? value);
      setFeedback("Appearance saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Appearance could not be saved.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div ref={rootRef} data-testid="settings-shell">
      {!(phone && activeGroup) && <ViewHeader title="Settings" />}
      <div className="grid gap-6 md:grid-cols-[180px_minmax(0,1fr)] md:gap-8">
        <SettingsSidebar active={activeGroup} onSelect={openSection} />
        <div className="min-w-0">
          {phone && !activeGroup && <SettingsList onSelect={openSection} />}
          <div
            data-testid="settings-panel"
            className={cn("min-w-0 max-w-4xl", !activeGroup && "hidden")}
          >
            {phone && activeGroup && (
              <div
                data-testid="settings-detail"
                data-group={activeGroup}
                className="mb-4 flex min-h-11 items-center gap-1 md:hidden"
              >
                <Button
                  variant="ghost"
                  size="icon"
                  data-testid="settings-back"
                  aria-label="All settings"
                  className="-ml-2 min-h-11 min-w-11"
                  onClick={backToList}
                >
                  <ArrowLeft />
                </Button>
                <h2 className="font-headline text-base font-medium text-on-surface">
                  {activeGroupMeta?.label}
                </h2>
              </div>
            )}

            {mounted("general") && (
              <div hidden={activeGroup !== "general"} className="space-y-8">
                <section aria-label="Appearance settings">
                  <h2 className="mb-2 text-base font-medium">Appearance</h2>
                  <p className="mb-5 text-xs text-muted-foreground">Changes save immediately.</p>
                  <div className="space-y-6">
                    <div>
                      <h3 className="mb-2 text-sm font-medium">Theme</h3>
                      <fieldset aria-label="Theme" className="flex gap-2">
                        {(["dark", "light"] as const).map((value) => (
                          <Button
                            key={value}
                            variant={theme === value ? "secondary" : "outline"}
                            aria-pressed={theme === value}
                            data-testid={`settings-theme-${value}`}
                            disabled={pending}
                            onClick={() => void changeTheme(value)}
                          >
                            {value === "dark" ? "Dark" : "Light"}
                          </Button>
                        ))}
                      </fieldset>
                    </div>
                    <div>
                      <h3 className="mb-2 text-sm font-medium">Font size</h3>
                      <fieldset aria-label="Font size" className="flex flex-wrap gap-2">
                        {FONT_SIZES.map(({ value, label, hint }) => (
                          <Button
                            key={value}
                            variant={fontSize === value ? "secondary" : "outline"}
                            aria-pressed={fontSize === value}
                            data-testid={`settings-font-size-${value}`}
                            title={hint}
                            onClick={() => setFontSize(value)}
                          >
                            {label}
                          </Button>
                        ))}
                      </fieldset>
                      <p className="mt-2 text-xs text-muted-foreground">
                        Scales interface text in this browser; terminals keep their own font.
                      </p>
                    </div>
                  </div>
                </section>
                <section aria-label="Terminal settings" className="border-t border-border pt-8">
                  <h2 className="mb-2 text-base font-medium">Terminals</h2>
                  <p className="mb-5 text-xs text-muted-foreground">
                    Applies to newly opened terminals.
                  </p>
                  <div className="grid gap-4 lg:grid-cols-[minmax(160px,1fr)_minmax(0,2fr)]">
                    <div>
                      <Label htmlFor="settings-terminal-font">Terminal font family</Label>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Nerd Fonts support prompt and agent icons. Leave blank to choose
                        automatically.
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Input
                        id="settings-terminal-font"
                        value={terminalFont}
                        onChange={(event) => setTerminalFont(event.target.value)}
                        placeholder="e.g. MesloLGS NF"
                      />
                    </div>
                  </div>
                  <div className="mt-6 flex flex-wrap items-center gap-2">
                    <Button
                      data-testid="settings-terminal-save"
                      disabled={pending}
                      onClick={() => void saveTerminal()}
                    >
                      {feedback ? <CheckCircle size={14} /> : <Save size={14} />}Save changes
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={pending}
                      onClick={() => void saveTerminal(true)}
                    >
                      Reset font
                    </Button>
                  </div>
                </section>
                {desktopBridge()?.preview && (
                  <div className="border-t border-border pt-8">
                    <BrowserSettings />
                  </div>
                )}
              </div>
            )}

            {mounted("hosts") && (
              <div hidden={activeGroup !== "hosts"}>
                <HostsSettings
                  expandExecution={rawSection === "execution"}
                  expandConnection={rawSection === "connection"}
                />
              </div>
            )}

            {mounted("agents") && (
              <div hidden={activeGroup !== "agents"}>
                <Tabs value={agentTab} onValueChange={(value) => setAgentTab(value as AgentTab)}>
                  <TabsList aria-label="Agents sections" className="mb-5">
                    {AGENT_TABS.map((value) => (
                      <TabsTrigger key={value} value={value} data-testid={`agents-tab-${value}`}>
                        {agentTabLabels[value]}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                  <TabsContent
                    value="providers"
                    forceMount
                    className="data-[state=inactive]:hidden"
                  >
                    <AgentSettings />
                  </TabsContent>
                  <TabsContent value="chat" forceMount className="data-[state=inactive]:hidden">
                    <ChatSettingsForm onManageProviders={() => setAgentTab("providers")} />
                  </TabsContent>
                  <TabsContent value="mcp" forceMount className="data-[state=inactive]:hidden">
                    <McpSettingsForm />
                  </TabsContent>
                </Tabs>
              </div>
            )}

            {mounted("connections") && (
              <div hidden={activeGroup !== "connections"}>
                <Tabs
                  value={connectionTab}
                  onValueChange={(value) => setConnectionTab(value as ConnectionTab)}
                >
                  <TabsList aria-label="Connections sections" className="mb-5">
                    {CONNECTION_TABS.map((value) => (
                      <TabsTrigger
                        key={value}
                        value={value}
                        data-testid={`connections-tab-${value}`}
                      >
                        {connectionTabLabels[value]}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                  <TabsContent value="channels" forceMount className="data-[state=inactive]:hidden">
                    <ChannelSettings
                      active={
                        panelVisible &&
                        activeGroup === "connections" &&
                        connectionTab === "channels"
                      }
                    />
                  </TabsContent>
                  <TabsContent
                    value="integrations"
                    forceMount
                    className="data-[state=inactive]:hidden"
                  >
                    <IntegrationsSettings
                      active={
                        panelVisible &&
                        activeGroup === "connections" &&
                        connectionTab === "integrations"
                      }
                    />
                  </TabsContent>
                </Tabs>
              </div>
            )}

            {mounted("knowledge") && (
              <div hidden={activeGroup !== "knowledge"}>
                <KnowledgeSettings />
              </div>
            )}

            {mounted("notifications") && (
              <div hidden={activeGroup !== "notifications"}>
                <NotificationSettings />
                <div className="mt-8 border-t border-border pt-8">
                  <AttentionSettings />
                </div>
                <div className="mt-8 border-t border-border pt-8">
                  <RetentionSettings />
                </div>
              </div>
            )}

            {mounted("usage") && (
              <div hidden={activeGroup !== "usage"}>
                <UsageSettings />
              </div>
            )}

            {mounted("security") && (
              <div hidden={activeGroup !== "security"}>
                <SecuritySettings active={panelVisible && activeGroup === "security"} />
              </div>
            )}

            {mounted("about") && (
              <div hidden={activeGroup !== "about"}>
                <AboutSettings />
                <div className="mt-8 border-t border-border pt-8">
                  <ServerSettings />
                </div>
                <section aria-label="Settings storage" className="mt-8 border-t border-border pt-8">
                  <h2 className="mb-3 text-base font-medium">Data locations</h2>
                  <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
                    Workspace preferences and SSH selection are saved in the server's{" "}
                    <code>~/.orc/config.json</code>. Saved ORC servers and their tokens are kept in
                    this browser; sign-in uses an HttpOnly cookie, never the API secret. The desktop
                    app keeps its selected server, token and headers in the app's data folder.
                  </p>
                </section>
              </div>
            )}

            {error && (
              <p role="alert" className="mt-4 text-sm text-error">
                {error}
              </p>
            )}
            {feedback && !error && (
              <p role="status" className="mt-4 text-sm text-muted-foreground">
                {feedback}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
