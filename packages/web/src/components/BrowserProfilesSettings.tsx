import type { PreviewImportSource, PreviewProfile } from "@orc/core/desktop-preview";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { desktopBridge } from "@/lib/desktop-bridge";

export function BrowserProfilesSettings() {
  const bridge = desktopBridge()?.preview;
  const [profiles, setProfiles] = useState<PreviewProfile[]>([]);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState("");
  const [port, setPort] = useState("9222");
  const [source, setSource] = useState<PreviewImportSource | null>(null);
  const [sites, setSites] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    void bridge
      ?.profiles()
      .then(setProfiles)
      .catch(() => setError("Browser profiles could not be loaded"));
    return () => {
      void bridge?.cancelImport();
    };
  }, [bridge]);
  async function run(work: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Browser profile operation failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="border-b border-border py-4" data-testid="browser-profiles-settings">
      <h3 className="text-sm font-medium">Saved browser profiles</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Log in inside ORC to keep a login here. Each chat starts in temporary mode. Choosing the
        same saved profile explicitly shares its cookies and site storage between those chats.
      </p>
      <form
        className="mt-3 flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            if (!bridge) return;
            const profile = await bridge.createProfile(name.trim());
            setProfiles(await bridge.profiles());
            setSelected(profile.id);
            setName("");
            setStatus("Profile created. Select it from the browser panel in a chat.");
          });
        }}
      >
        <input
          aria-label="New browser profile name"
          data-testid="browser-profile-name"
          className="form-control form-control-single min-w-0 flex-1"
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Work account"
        />
        <Button type="submit" disabled={busy || !name.trim()} data-testid="browser-profile-create">
          Create profile
        </Button>
      </form>
      {profiles.length > 0 && (
        <select
          aria-label="Saved browser profile"
          data-testid="browser-profile-select"
          className="form-control form-control-single mt-3"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
        >
          <option value="">Choose a profile</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
      )}
      <details className="mt-4" data-testid="browser-import-settings">
        <summary className="cursor-pointer text-sm">Import selected browser logins</summary>
        <p className="my-2 text-xs text-muted-foreground">
          Connect a Chrome/Edge profile whose local debugging endpoint you enabled, then select
          sites and a destination profile. Approve any prompt in that browser. Only selected sites’
          cookies are copied; the agent never receives this connection. Passwords, local storage and
          device-bound sessions are not transferred. Some sites require logging in again. Windows
          encrypted cookie files cannot be copied directly.
        </p>
        <a
          className="text-xs underline"
          href="https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session"
          target="_blank"
          rel="noreferrer"
        >
          Chrome connection instructions
        </a>
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            type="number"
            min={1024}
            max={65535}
            aria-label="Source browser debugging port"
            data-testid="browser-import-port"
            className="form-control form-control-single w-28"
            value={port}
            onChange={(event) => setPort(event.target.value)}
          />
          <Button
            disabled={busy || !selected}
            data-testid="browser-import-discover"
            onClick={() =>
              void run(async () => {
                if (!bridge) return;
                setSource(null);
                setSites([]);
                setSource(await bridge.discoverImport(Number(port)));
              })
            }
          >
            Find source sites
          </Button>
        </div>
        {source && (
          <div className="mt-3">
            <p className="text-xs text-muted-foreground">
              {source.name} · Select sites to copy into{" "}
              {profiles.find((profile) => profile.id === selected)?.name}
            </p>
            <div className="mt-2 max-h-48 overflow-y-auto">
              {source.sites.map((site) => (
                <label key={site} className="flex min-h-9 items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={sites.includes(site)}
                    onChange={(event) =>
                      setSites((old) =>
                        event.target.checked
                          ? [...old, site]
                          : old.filter((value) => value !== site),
                      )
                    }
                  />
                  {site}
                </label>
              ))}
            </div>
            <Button
              className="mt-2"
              disabled={busy || !selected || !sites.length}
              data-testid="browser-import-transfer"
              onClick={() =>
                void run(async () => {
                  if (!bridge) return;
                  const result = await bridge.transferImport(source.id, selected, sites);
                  setSource(null);
                  setSites([]);
                  setStatus(
                    `Imported ${result.imported} cookies; skipped ${result.skipped}. Check the selected sites in ORC; import does not guarantee a login.`,
                  );
                })
              }
            >
              Import selected sites
            </Button>
          </div>
        )}
      </details>
      {busy && (
        <Button variant="ghost" onClick={() => void bridge?.cancelImport()}>
          Cancel import
        </Button>
      )}
      {busy && (
        <p role="status" className="mt-2 text-xs">
          Working…
        </p>
      )}
      {status && (
        <p role="status" className="mt-2 text-xs">
          {status}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-error">
          {error}
        </p>
      )}
    </div>
  );
}
