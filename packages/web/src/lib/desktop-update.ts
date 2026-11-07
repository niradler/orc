import type { DesktopUpdateState } from "./desktop-bridge";

export function updateStatusText(state: DesktopUpdateState): string {
  switch (state.phase) {
    case "unavailable":
      return "Updates run in an installed app.";
    case "checking":
      return "Checking for updates…";
    case "downloading":
      return state.progress == null
        ? "Downloading update…"
        : `Downloading update… ${Math.round(state.progress)}%`;
    case "downloaded":
      return state.availableVersion
        ? `Version ${state.availableVersion} is ready to install.`
        : "An update is ready to install.";
    case "current":
      return "This app is up to date.";
    case "error":
      return state.error ?? "Update check failed.";
    default:
      return state.checksEnabled ? "Automatic checks are on." : "Automatic checks are off.";
  }
}

export function formatCheckedAt(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    date,
  );
}
