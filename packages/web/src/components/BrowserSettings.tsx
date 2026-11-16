import { PreviewPreferencesSchema } from "@orc/core/desktop-preview";
import { HelpPopover } from "@/components/HelpPopover";
import { Button } from "@/components/ui/button";
import { usePreviewPreferences } from "@/hooks/usePreviewPreferences";
import { BrowserProfilesSettings } from "./BrowserProfilesSettings";

export function BrowserSettings() {
  const { settings, error, busy, save } = usePreviewPreferences();
  return (
    <section aria-label="Browser settings" data-testid="browser-settings">
      <div className="mb-2 flex items-center gap-1">
        <h2 className="text-base font-medium">Browser</h2>
        <HelpPopover label="Browser" testId="browser-help">
          Logins in the ORC browser and saved profiles persist across chats and restarts; temporary
          ones end with the chat. Camera, microphone and location stay blocked. Browser downloads
          are staged safely and can be saved to the chat workspace. File previews stay inside ORC;
          the external-link icon opens a source in VS Code.
        </HelpPopover>
      </div>
      <p className="mb-6 text-xs text-muted-foreground">
        Saved on this desktop. Changes apply immediately.
      </p>
      {error && (
        <p role="alert" className="mb-4 text-sm text-error">
          {error}
        </p>
      )}
      {!settings && !error && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading browser settings…
        </p>
      )}
      {settings && (
        <>
          <div className="grid gap-4 border-b border-border py-4 sm:grid-cols-[minmax(160px,1fr)_minmax(0,2fr)]">
            <label htmlFor="browser-open-links" className="text-sm font-medium">
              Open web links in
            </label>
            <select
              id="browser-open-links"
              data-testid="browser-open-links"
              className="form-control form-control-single"
              disabled={busy}
              value={settings.openLinksIn}
              onChange={(event) =>
                void save({
                  ...settings,
                  openLinksIn: event.target.value === "system" ? "system" : "preview",
                })
              }
            >
              <option value="preview">ORC preview panel</option>
              <option value="system">System browser</option>
            </select>
          </div>
          <div className="flex items-start justify-between gap-6 border-b border-border py-4">
            <div className="flex items-center gap-1">
              <label htmlFor="browser-agent-access" className="text-sm font-medium">
                Agent browser control
              </label>
              <HelpPopover label="Agent browser control" testId="browser-agent-access-help">
                On by default. Agents in the selected conversation can read, screenshot and interact
                with its browser, including pages you sign into. Turn it off here for every
                conversation, or use Session settings for one chat.
              </HelpPopover>
            </div>
            <input
              id="browser-agent-access"
              data-testid="browser-agent-access"
              type="checkbox"
              className="mt-1 h-4 w-4 shrink-0"
              checked={settings.agentBrowserControl}
              disabled={busy}
              onChange={(event) =>
                void save({ ...settings, agentBrowserControl: event.target.checked })
              }
            />
          </div>
          <BrowserProfilesSettings />
        </>
      )}
      <Button
        variant="ghost"
        className="mt-5"
        disabled={busy}
        onClick={() => void save(PreviewPreferencesSchema.parse({}))}
      >
        Reset browser settings
      </Button>
      {busy && (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          Saving…
        </p>
      )}
    </section>
  );
}
