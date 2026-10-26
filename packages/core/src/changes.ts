export const CHANGE_RESOURCES = [
  "tasks",
  "sessions",
  "jobs",
  "webhooks",
  "projects",
  "memories",
  "memory-usage",
  "knowledge",
  "skills",
  "skill-usage",
  "agents",
  "flows",
  "rules",
  "human-requests",
  "settings",
  "ssh",
  "terminals",
  "git",
  "files",
  "backends",
  "packages",
  "health",
  "github",
  "audit",
  "scratchpads",
] as const;

export type ChangeResource = (typeof CHANGE_RESOURCES)[number];
export type ResourceChange = { resources: ChangeResource[] };

export class ChangeHub {
  private readonly listeners = new Set<(change: ResourceChange) => void>();

  subscribe(listener: (change: ResourceChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(...resources: ChangeResource[]): void {
    const change = { resources: [...new Set(resources)] };
    if (!change.resources.length) return;
    for (const listener of this.listeners) listener(change);
  }
}

export const changes = new ChangeHub();
