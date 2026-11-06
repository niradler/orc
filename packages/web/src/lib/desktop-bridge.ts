import type { NotificationLevel } from "./agent-notifications";

export interface DesktopNotification {
  title: string;
  body: string;
  path: string;
  level: NotificationLevel;
}

/** Exposed by the Electron preload; absent in a plain browser. */
export interface OrcDesktopBridge {
  notify(notification: DesktopNotification): void;
  onOpen(listener: (path: string) => void): () => void;
}

export function desktopBridge(): OrcDesktopBridge | undefined {
  return (window as Window & { orcDesktop?: OrcDesktopBridge }).orcDesktop;
}
