import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { api } from "@/api/client";
import { useHealth } from "@/hooks/useHealth";
import { desktopVersions, formatUptime } from "@/lib/about";

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

export function AboutSettings() {
  const { data: health } = useHealth();
  const about = useQuery({ queryKey: ["system-about"], queryFn: () => api.system.about() });
  const desktop = desktopVersions(navigator.userAgent);
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
