import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useHealth } from "@/hooks/useHealth";
import { desktopVersions, formatUptime } from "@/lib/about";
import {
  type DesktopUpdateChannel,
  type DesktopUpdateState,
  desktopBridge,
} from "@/lib/desktop-bridge";
import { formatCheckedAt, updateStatusText } from "@/lib/desktop-update";

const REPO = "https://github.com/niradler/orc";
const LINKS = [
  { id: "repo", label: "Source code", href: REPO },
  { id: "releases", label: "Releases and changelog", href: `${REPO}/releases` },
  { id: "issues", label: "Report an issue", href: `${REPO}/issues` },
  { id: "docs", label: "Documentation", href: `${REPO}/tree/master/docs` },
  { id: "npm", label: "npm package (orc-ai)", href: "https://www.npmjs.com/package/orc-ai" },
] as const;

const PLATFORM_NAMES: Record<string, string> = {
  win32: "Windows",
  darwin: "macOS",
  linux: "Linux",
};

function Row({ id, label, value }: { id: string; label: string; value: string | undefined }) {
  return (
    <div className="grid gap-1 border-b border-border py-2.5 text-sm sm:grid-cols-[180px_minmax(0,1fr)] sm:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd data-testid={`about-${id}`} className="min-w-0 break-words font-mono text-[13px]">
        {value ?? "—"}
      </dd>
    </div>
  );
}

function DesktopUpdates({ state }: { state: DesktopUpdateState }) {
  const updates = desktopBridge()?.updates;
  const [actionError, setActionError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await action();
    } catch {
      setActionError("The update action failed. Please try again.");
    }
  };
  const checked = formatCheckedAt(state.lastCheckedAt);
  const busy = state.phase === "checking" || state.phase === "downloading";
  const save = (channel: DesktopUpdateChannel, checksEnabled: boolean) => {
    if (updates) void run(() => updates.setPreferences({ channel, checksEnabled }));
  };
  return (
    <div className="mt-8 max-w-3xl" data-testid="about-updates">
      <h3 className="mb-2 text-sm font-medium">Updates</h3>
      <p className="text-sm text-muted-foreground" data-testid="about-update-status">
        {updateStatusText(state)}
      </p>
      {actionError && (
        <p role="alert" className="mt-2 text-sm text-error" data-testid="about-update-error">
          {actionError}
        </p>
      )}
      {checked && (
        <p className="mt-1 text-xs text-muted-foreground" data-testid="about-update-checked">
          Last check {checked}
        </p>
      )}
      <div className="mt-4 grid gap-4 sm:grid-cols-[180px_minmax(0,1fr)] sm:items-center">
        <Label htmlFor="about-update-channel">Channel</Label>
        <Select
          value={state.channel}
          onValueChange={(value) => {
            if (value === "stable" || value === "preview") save(value, state.checksEnabled);
          }}
        >
          <SelectTrigger id="about-update-channel" data-testid="about-update-channel">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="stable">Stable</SelectItem>
            <SelectItem value="preview">Preview</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <label className="mt-4 flex min-h-11 items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4 accent-foreground"
          checked={state.checksEnabled}
          data-testid="about-update-checks"
          onChange={(event) => save(state.channel, event.target.checked)}
        />
        Check for updates
      </label>
      <p className="mt-1 text-xs text-muted-foreground">
        Stable follows GitHub releases. Preview also includes prereleases. The bundled daemon
        restarts with the app. Tasks and sessions stay in the data folder.
      </p>
      {state.phase === "downloaded" && state.releaseNotes && (
        <pre
          className="mt-4 max-h-48 overflow-auto whitespace-pre-wrap font-sans text-sm text-foreground"
          data-testid="about-update-notes"
        >
          {state.releaseNotes}
        </pre>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={!state.packaged || busy}
          data-testid="about-update-check"
          onClick={() => updates && void run(() => updates.check())}
        >
          Check now
        </Button>
        {state.phase === "downloaded" && (
          <Button
            type="button"
            data-testid="about-update-install"
            onClick={() => updates && void run(() => updates.install())}
          >
            Restart to update
          </Button>
        )}
      </div>
    </div>
  );
}

export function AboutSettings() {
  const { data: health } = useHealth();
  const about = useQuery({ queryKey: ["system-about"], queryFn: () => api.system.about() });
  const desktop = desktopVersions(navigator.userAgent);
  const updates = desktopBridge()?.updates;
  const [update, setUpdate] = useState<DesktopUpdateState | null>(null);
  const [updateUnavailable, setUpdateUnavailable] = useState(false);
  useEffect(() => {
    if (!updates) return;
    let live = true;
    void updates
      .state()
      .then((next) => {
        if (live) setUpdate(next);
      })
      .catch(() => {
        if (live) setUpdateUnavailable(true);
      });
    const stop = updates.onChange(setUpdate);
    return () => {
      live = false;
      stop();
    };
  }, [updates]);
  const info = about.data;
  return (
    <section aria-labelledby="about-title" data-testid="settings-about">
      <h2 id="about-title" className="mb-6 text-base font-medium">
        About
      </h2>
      <dl className="max-w-3xl">
        <Row id="server-version" label="Server version" value={info?.version ?? health?.version} />
        {desktop && <Row id="desktop-version" label="Desktop app" value={desktop.app} />}
        {desktop && <Row id="electron-version" label="Electron" value={desktop.electron} />}
        <Row
          id="platform"
          label="Server platform"
          value={
            info &&
            `${PLATFORM_NAMES[info.platform] ?? info.platform} ${info.os_release} (${info.arch})`
          }
        />
        <Row id="runtime" label="Runtime" value={info?.runtime} />
        <Row id="data-dir" label="Data folder" value={info?.data_dir} />
        <Row id="uptime" label="Uptime" value={health ? formatUptime(health.uptime) : undefined} />
        <Row id="instance" label="Instance" value={info?.instance_id ?? health?.instance_id} />
      </dl>
      {about.isError && (
        <p role="alert" className="mt-3 text-sm text-error">
          Server details are unavailable: {about.error.message}
        </p>
      )}
      {update && <DesktopUpdates state={update} />}
      {updateUnavailable && (
        <p role="alert" className="mt-3 text-sm text-error">
          Desktop update settings are unavailable. Reload to try again.
        </p>
      )}
      <h3 className="mt-8 mb-2 text-sm font-medium">Links</h3>
      <ul className="max-w-3xl space-y-0.5">
        {LINKS.map((link) => (
          <li key={link.id}>
            <a
              href={link.href}
              target="_blank"
              rel="noreferrer"
              data-testid={`about-link-${link.id}`}
              className="inline-flex min-h-8 items-center gap-1.5 rounded-sm text-sm text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring max-md:min-h-11"
            >
              {link.label}
              <ExternalLink aria-hidden="true" className="size-3.5 text-muted-foreground" />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
