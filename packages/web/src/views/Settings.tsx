import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle, Save } from "lucide-react";
import { useState } from "react";
import { api, getApiUrl } from "@/api/client";
import { KnowledgeSettings } from "@/components/kb/KnowledgeSettings";
import { SshHostSettings } from "@/components/SshHostSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { ViewHeader } from "@/components/ViewHeader";
import { API_ACCESS_CHANGED } from "@/lib/api-credentials";
import { TERMINAL_FONT_KEY } from "@/lib/terminal-runtime";
import { setTheme, useTheme } from "@/lib/theme";

export default function Settings() {
  const { theme } = useTheme();
  const [apiUrl, setApiUrl] = useState(getApiUrl);
  const [terminalFont, setTerminalFont] = useState(
    () => localStorage.getItem(TERMINAL_FONT_KEY) ?? "",
  );
  const [saved, setSaved] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [storageError, setStorageError] = useState("");
  const [pending, setPending] = useState(false);
  const qc = useQueryClient();

  const handleSave = async () => {
    setStorageError("");
    setPending(true);
    try {
      const target = apiUrl.trim();
      if (target && !target.startsWith("/") && !/^https?:\/\//i.test(target))
        throw new Error("Use a relative API path or an http(s) server URL.");
      const preferences = await api.settings.save({ theme, terminal_font: terminalFont.trim() });
      setTheme(preferences.theme ?? theme);
      setTerminalFont(preferences.terminal_font ?? "");
      if (preferences.terminal_font)
        localStorage.setItem(TERMINAL_FONT_KEY, preferences.terminal_font);
      else localStorage.removeItem(TERMINAL_FONT_KEY);
      const changed = (target || "/api") !== getApiUrl();
      localStorage.setItem("orc_api_url", target || "/api");
      if (changed) window.dispatchEvent(new Event(API_ACCESS_CHANGED));
      qc.invalidateQueries();
      setSaved(true);
      setFeedback("Workspace preferences saved on the server. API address saved in this browser.");
      setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      setStorageError(
        error instanceof Error ? error.message : "Browser settings could not be saved.",
      );
    } finally {
      setPending(false);
    }
  };

  const handleReset = async () => {
    setStorageError("");
    setPending(true);
    try {
      const preferences = await api.settings.save({ terminal_font: "" });
      localStorage.removeItem("orc_api_url");
      localStorage.setItem(TERMINAL_FONT_KEY, preferences.terminal_font ?? "");
      setApiUrl("/api");
      setTerminalFont(preferences.terminal_font ?? "");
      window.dispatchEvent(new Event(API_ACCESS_CHANGED));
      qc.invalidateQueries();
      setSaved(false);
      setFeedback(
        "Connection and terminal font restored to their defaults. Appearance and execution host were kept.",
      );
    } catch (error) {
      setStorageError(
        error instanceof Error ? error.message : "Browser settings could not be reset.",
      );
    } finally {
      setPending(false);
    }
  };

  async function changeTheme(value: "dark" | "light"): Promise<void> {
    setStorageError("");
    setPending(true);
    try {
      const preferences = await api.settings.save({ theme: value });
      setTheme(preferences.theme ?? value);
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : "Appearance could not be saved.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <ViewHeader title="Settings" />

      <div className="max-w-lg space-y-8">
        <section aria-labelledby="appearance-title">
          <h2 id="appearance-title" className="mb-1 text-base font-medium">
            Appearance
          </h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Choose a workspace theme. Your choice is saved on the server immediately.
          </p>
          <fieldset className="flex flex-wrap gap-2" aria-label="Theme">
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
        {/* API connection */}
        <section>
          <h2 className="font-headline font-medium text-base  text-on-surface mb-1">
            API connection
          </h2>
          <p className="font-body text-sm text-muted-foreground mb-4">
            Connect this workspace to an ORC server. The default{" "}
            <code className="text-primary">/api</code> uses the current server or the configured
            development proxy.
          </p>
          <Separator className="bg-outline-variant mb-4" />
          <div className="space-y-4">
            <div className="space-y-2">
              <Label
                htmlFor="settings-api-url"
                className="font-label text-sm text-muted-foreground"
              >
                API base URL
              </Label>
              <Input
                id="settings-api-url"
                data-testid="settings-api-url"
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                placeholder="/api  or  http://localhost:7700"
                className="bg-background text-on-surface font-body text-sm"
              />
              <p className="font-body text-sm text-muted-foreground">
                Use <code>/api</code> (dev proxy) or a direct URL when CORS is enabled.
              </p>
            </div>
          </div>
        </section>

        <SshHostSettings />

        <KnowledgeSettings />

        {/* Terminal */}
        <section>
          <h2 className="font-headline font-medium text-base  text-on-surface mb-1">Terminal</h2>
          <p className="font-body text-sm text-muted-foreground mb-4">
            Prompt and agent status icons need a Nerd Font installed on this machine. Common ones
            are tried automatically; set the exact family name if your icons show as empty boxes.
            Applies to terminals opened after saving.
          </p>
          <Separator className="bg-outline-variant mb-4" />
          <div className="space-y-2">
            <Label
              htmlFor="settings-terminal-font"
              className="font-label text-sm text-muted-foreground"
            >
              Terminal font family
            </Label>
            <Input
              id="settings-terminal-font"
              value={terminalFont}
              onChange={(e) => setTerminalFont(e.target.value)}
              placeholder="e.g. MesloLGS NF"
              className="bg-background text-on-surface font-body text-sm"
            />
          </div>
        </section>

        {/* Actions */}
        <div className="flex flex-wrap gap-3 pt-2">
          <Button
            data-testid="settings-save"
            disabled={pending}
            onClick={() => void handleSave()}
            className="font-label text-sm "
          >
            {saved ? (
              <>
                <CheckCircle size={12} className="mr-1.5" /> Saved
              </>
            ) : (
              <>
                <Save size={12} className="mr-1.5" /> Save settings
              </>
            )}
          </Button>
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => void handleReset()}
            className="font-label text-sm text-muted-foreground hover:text-on-surface"
          >
            Reset to defaults
          </Button>
        </div>
        {storageError && (
          <p role="alert" className="text-sm text-error">
            {storageError}
          </p>
        )}
        {feedback && !storageError && (
          <p role="status" className="text-sm text-muted-foreground">
            {feedback}
          </p>
        )}

        {/* Info */}
        <section>
          <Separator className="bg-outline-variant mb-4" />
          <div className="font-label text-sm  text-muted-foreground mb-2">Storage</div>
          <p className="font-body text-sm text-muted-foreground">
            Workspace preferences and SSH selection are persisted in the server's{" "}
            <code>~/.orc/config.json</code>. The API address and optionally remembered login are
            stored in this browser.
          </p>
        </section>
      </div>
    </div>
  );
}
