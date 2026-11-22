import type { PreviewImportSource, PreviewProfile } from "@orc/core/desktop-preview";
import { useEffect, useState } from "react";
import { HelpPopover } from "@/components/HelpPopover";
import { Button } from "@/components/ui/button";
import { desktopBridge } from "@/lib/desktop-bridge";

export function BrowserProfilesSettings() {
  const bridge = desktopBridge()?.preview;
  const [profiles, setProfiles] = useState<PreviewProfile[]>([]);
  const [name, setName] = useState("");
  const [rename, setRename] = useState("");
  const [selected, setSelected] = useState("default");
  const [port, setPort] = useState("9222");
  const [stores, setStores] = useState<{ id: string; name: string }[]>([]);
  const [store, setStore] = useState("");
  const [source, setSource] = useState<PreviewImportSource | null>(null);
  const [sites, setSites] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
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
  async function run(work: () => Promise<void>, importWork = false): Promise<void> {
    if (busy) return;
    setBusy(true);
    setImporting(importWork);
    setError(null);
    setStatus(null);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Browser profile operation failed");
    } finally {
      setBusy(false);
      setImporting(false);
    }
  }
  return (
    <div className="border-b border-border py-4" data-testid="browser-profiles-settings">
      <div className="flex items-center gap-1">
        <h3 className="text-sm font-medium">Browser profiles</h3>
        <HelpPopover label="Browser profiles" testId="browser-profiles-help">
          Every chat uses the ORC profile unless you pick another, so one login serves all chats and
          survives restarts. A saved profile keeps logins apart; temporary lasts one chat.
        </HelpPopover>
      </div>
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
      <select
        aria-label="Browser profile"
        data-testid="browser-profile-select"
        className="form-control form-control-single mt-3"
        value={selected}
        onChange={(event) => setSelected(event.target.value)}
      >
        <option value="default">ORC browser · default for every chat</option>
        {profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.name}
          </option>
        ))}
      </select>
      <div className="mt-2 flex flex-wrap gap-2">
        {selected !== "default" && (
          <input
            aria-label="Rename browser profile"
            data-testid="browser-profile-rename-name"
            className="form-control form-control-single min-w-0 flex-1"
            maxLength={80}
            value={rename}
            onChange={(event) => setRename(event.target.value)}
            placeholder="New profile name"
          />
        )}
        {selected !== "default" && (
          <Button
            disabled={busy || !rename.trim()}
            data-testid="browser-profile-rename"
            onClick={() =>
              void run(async () => {
                if (!bridge) return;
                await bridge.renameProfile(selected, rename.trim());
                setProfiles(await bridge.profiles());
                setRename("");
                setStatus("Profile renamed.");
              })
            }
          >
            Rename
          </Button>
        )}
        <Button
          variant="ghost"
          disabled={busy}
          data-testid="browser-profile-remove"
          onClick={() =>
            void run(async () => {
              if (!bridge) return;
              if (await bridge.removeProfile(selected)) {
                setProfiles(await bridge.profiles());
                setStatus(
                  selected === "default"
                    ? "ORC browser logins and site data cleared."
                    : "Profile removed and site data cleared.",
                );
                setSelected("default");
              }
            })
          }
        >
          {selected === "default" ? "Clear browser data" : "Remove profile"}
        </Button>
      </div>
      <details open className="mt-4" data-testid="browser-import-settings">
        <summary className="cursor-pointer text-sm">
          <span className="inline-flex items-center gap-1">
            Import logins from Chrome, Edge, Brave, Arc, Firefox or Safari
            <HelpPopover label="Importing logins" testId="browser-import-help">
              Copies selected sites' logins into the profile above. Close the source browser first;
              OS keychain approval may be needed. Sources: Chrome-family, Firefox or Safari.
            </HelpPopover>
          </span>
        </summary>
        <div className="my-2 flex flex-wrap gap-2">
          <Button
            disabled={busy || !selected}
            data-testid="browser-import-stores"
            onClick={() =>
              void run(async () => {
                if (!bridge) return;
                setSource(null);
                setSites([]);
                setStore("");
                setStores([]);
                const found = await bridge.importStores();
                setStores(found);
                if (!found.length)
                  setStatus(
                    "No supported cookie stores found. Use the live-browser connection below; Windows Chrome/Edge app-bound cookies require it.",
                  );
              }, true)
            }
          >
            Scan browser profiles
          </Button>
          {stores.length > 0 && (
            <select
              aria-label="Source browser profile"
              disabled={busy}
              className="form-control form-control-single min-w-0"
              value={store}
              onChange={(event) => setStore(event.target.value)}
            >
              <option value="">Choose source profile</option>
              {stores.map((value) => (
                <option key={value.id} value={value.id}>
                  {value.name}
                </option>
              ))}
            </select>
          )}
          {store && (
            <Button
              disabled={busy || !selected}
              data-testid="browser-import-store-discover"
              onClick={() =>
                void run(async () => {
                  if (!bridge) return;
                  setSource(null);
                  setSites([]);
                  setSource(await bridge.discoverStore(store));
                }, true)
              }
            >
              Choose source sites
            </Button>
          )}
        </div>
        <a
          className="text-xs underline"
          href="https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session"
          target="_blank"
          rel="noreferrer"
        >
          Chrome connection instructions
        </a>
        <div className="mt-3 flex flex-wrap items-center gap-2">
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
              }, true)
            }
          >
            Find source sites
          </Button>
          <HelpPopover label="Live browser connection" testId="browser-import-live-help">
            Connect a Chrome/Edge profile with local debugging enabled, then pick sites. Only those
            sites' cookies are copied; passwords and device-bound sessions are not. Some sites need
            a fresh sign-in.
          </HelpPopover>
        </div>
        {source && (
          <div className="mt-3">
            <p className="text-xs text-muted-foreground">
              {source.name} · Select sites to copy into{" "}
              {selected === "default"
                ? "the ORC browser"
                : profiles.find((profile) => profile.id === selected)?.name}
            </p>
            <label className="mt-2 flex min-h-9 items-center gap-2 text-xs font-medium">
              <input
                type="checkbox"
                data-testid="browser-import-all"
                checked={sites.length === source.sites.length}
                onChange={(event) => setSites(event.target.checked ? source.sites : [])}
              />
              All {source.sites.length} sites
            </label>
            <div className="max-h-48 overflow-y-auto">
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
                }, true)
              }
            >
              Import selected sites
            </Button>
          </div>
        )}
      </details>
      {importing && (
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
