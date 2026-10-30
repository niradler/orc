import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle, Save } from "lucide-react";
import { useState } from "react";
import { api, getApiUrl } from "@/api/client";
import { AttentionSettings } from "@/components/AttentionSettings";
import { ChatSettingsForm } from "@/components/ChatSettingsForm";
import { KnowledgeSettings } from "@/components/kb/KnowledgeSettings";
import { NotificationSettings } from "@/components/NotificationSettings";
import { ServerSettings } from "@/components/ServerSettings";
import { SshHostSettings } from "@/components/SshHostSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ViewHeader } from "@/components/ViewHeader";
import { API_ACCESS_CHANGED } from "@/lib/api-credentials";
import { TERMINAL_FONT_KEY } from "@/lib/terminal-runtime";
import { setTheme, useTheme } from "@/lib/theme";
import { useViewParam } from "@/lib/view-params";

const sections = [
  "connection",
  "appearance",
  "execution",
  "server",
  "notifications",
  "chat",
  "knowledge",
  "terminals",
  "storage",
] as const;
type Section = (typeof sections)[number];
const sectionLabels: Record<Section, string> = {
  connection: "Connection",
  appearance: "Appearance",
  execution: "Execution host",
  server: "Server",
  notifications: "Notifications",
  chat: "Chat",
  knowledge: "Knowledge",
  terminals: "Terminals",
  storage: "Storage",
};

export default function Settings() {
  const { theme } = useTheme();
  const [section, setSection] = useViewParam<Section>("settingsSection", "connection", sections);
  const [apiUrl, setApiUrl] = useState(getApiUrl);
  const [terminalFont, setTerminalFont] = useState(
    () => localStorage.getItem(TERMINAL_FONT_KEY) ?? "",
  );
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const qc = useQueryClient();
  function navigate(value: Section) {
    setSection(value);
    setError("");
    setFeedback("");
  }
  async function save(kind: "connection" | "terminals", reset = false) {
    setError("");
    setFeedback("");
    setPending(true);
    try {
      if (kind === "connection") {
        const target = reset ? "/api" : apiUrl.trim() || "/api";
        if (!target.startsWith("/") && !/^https?:\/\//i.test(target))
          throw new Error("Use a relative API path or an http(s) server URL.");
        const changed = target !== getApiUrl();
        localStorage.setItem("orc_api_url", target);
        setApiUrl(target);
        if (changed) window.dispatchEvent(new Event(API_ACCESS_CHANGED));
        setFeedback(
          reset
            ? "Connection restored to the current server."
            : "Connection saved in this browser.",
        );
      } else {
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
      }
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
  const saveActions = (kind: "connection" | "terminals") => (
    <div className="mt-6 flex flex-wrap items-center gap-2">
      <Button
        data-testid={kind === "connection" ? "settings-save" : "settings-terminal-save"}
        disabled={pending}
        onClick={() => void save(kind)}
      >
        {feedback ? <CheckCircle size={14} /> : <Save size={14} />}Save changes
      </Button>
      <Button variant="ghost" disabled={pending} onClick={() => void save(kind, true)}>
        Reset {kind === "connection" ? "connection" : "font"}
      </Button>
    </div>
  );
  return (
    <div>
      <ViewHeader title="Settings" />
      <div className="grid gap-6 md:grid-cols-[160px_minmax(0,1fr)] md:gap-8">
        <nav aria-label="Settings sections" className="hidden space-y-1 md:block">
          {sections.map((id) => (
            <Button
              key={id}
              data-testid={`settings-section-${id}`}
              variant={section === id ? "secondary" : "ghost"}
              aria-current={section === id ? "page" : undefined}
              onClick={() => navigate(id)}
              className="w-full justify-start"
            >
              {sectionLabels[id]}
            </Button>
          ))}
        </nav>
        <label className="md:hidden">
          <span className="sr-only">Settings section</span>
          <select
            aria-label="Settings section"
            className="form-control form-control-single"
            value={section}
            onChange={(event) => navigate(event.target.value as Section)}
          >
            {sections.map((id) => (
              <option key={id} value={id}>
                {sectionLabels[id]}
              </option>
            ))}
          </select>
        </label>
        <div className="min-w-0 max-w-4xl">
          <section hidden={section !== "connection"} aria-label="Connection settings">
            <h2 className="mb-6 text-base font-medium">Connection</h2>
            <div className="grid gap-4 border-b border-border pb-6 lg:grid-cols-[minmax(160px,1fr)_minmax(0,2fr)]">
              <div>
                <Label htmlFor="settings-api-url">API connection</Label>
                <p className="mt-1 text-xs text-muted-foreground">Saved in this browser.</p>
              </div>
              <div className="space-y-2">
                <Input
                  id="settings-api-url"
                  data-testid="settings-api-url"
                  value={apiUrl}
                  onChange={(event) => setApiUrl(event.target.value)}
                  placeholder="/api or http://localhost:7700"
                />
                <p className="text-xs text-muted-foreground">
                  <code>/api</code> uses the current server or development proxy.
                </p>
              </div>
            </div>
            {saveActions("connection")}
          </section>
          <section hidden={section !== "appearance"} aria-label="Appearance settings">
            <h2 className="mb-2 text-base font-medium">Appearance</h2>
            <p className="mb-5 text-xs text-muted-foreground">Changes save immediately.</p>
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
          </section>
          <div hidden={section !== "execution"}>
            <SshHostSettings />
          </div>
          <div hidden={section !== "server"}>
            <ServerSettings />
          </div>
          <div hidden={section !== "notifications"}>
            <NotificationSettings />
            <AttentionSettings />
          </div>
          <div hidden={section !== "chat"}>
            <ChatSettingsForm />
          </div>
          <div hidden={section !== "knowledge"}>
            <KnowledgeSettings />
          </div>
          <section hidden={section !== "terminals"} aria-label="Terminal settings">
            <h2 className="mb-6 text-base font-medium">Terminals</h2>
            <div className="grid gap-4 border-b border-border pb-6 lg:grid-cols-[minmax(160px,1fr)_minmax(0,2fr)]">
              <div>
                <Label htmlFor="settings-terminal-font">Terminal font family</Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  Applies to newly opened terminals.
                </p>
              </div>
              <div className="space-y-2">
                <Input
                  id="settings-terminal-font"
                  value={terminalFont}
                  onChange={(event) => setTerminalFont(event.target.value)}
                  placeholder="e.g. MesloLGS NF"
                />
                <p className="text-xs text-muted-foreground">
                  Nerd Fonts support prompt and agent icons. Leave blank to choose automatically.
                </p>
              </div>
            </div>
            {saveActions("terminals")}
          </section>
          <section hidden={section !== "storage"} aria-label="Settings storage">
            <h2 className="mb-3 text-base font-medium">Storage</h2>
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
              Workspace preferences and SSH selection are saved in the server's{" "}
              <code>~/.orc/config.json</code>. The API address and optionally remembered login are
              stored in this browser.
            </p>
          </section>
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
  );
}
