export function desktopVersions(userAgent: string): { app: string; electron: string } | null {
  const electron = /\bElectron\/([\w.-]+)/.exec(userAgent)?.[1];
  if (!electron) return null;
  return { app: /\borc\/([\w.-]+)/.exec(userAgent)?.[1] ?? "unknown", electron };
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
