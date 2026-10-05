import { readRegistrations } from "@orc/core/live-session";
import { isAlive } from "./common.js";
import type { SessionAdapter, SessionRecord } from "./types.js";

export function lifecycleRecords(dir?: string): SessionRecord[] {
  return readRegistrations(dir).map((record) => ({
    backend: record.backend,
    externalId: record.externalId,
    title: record.title,
    ...(record.cwd !== undefined ? { cwd: record.cwd } : {}),
    ...(record.transcriptPath !== undefined ? { transcriptPath: record.transcriptPath } : {}),
    pid: record.pid,
    status: isAlive(record.pid) ? record.status : "stopped",
    createdAt: new Date(record.createdAt),
    lastActivityAt: new Date(record.updatedAt),
  }));
}

export function withLifecycle(adapter: SessionAdapter, dir?: string): SessionAdapter {
  return {
    ...adapter,
    async list(known) {
      const records = new Map(
        (await adapter.list(known)).map((record) => [record.externalId, record]),
      );
      for (const live of lifecycleRecords(dir)) {
        if (live.backend !== adapter.backend) continue;
        const previous = records.get(live.externalId);
        records.set(live.externalId, {
          ...previous,
          ...live,
          title: previous?.title ?? live.title,
          transcriptPath: live.transcriptPath ?? previous?.transcriptPath ?? null,
          lastActivityAt: new Date(
            Math.max(previous?.lastActivityAt.getTime() ?? 0, live.lastActivityAt.getTime()),
          ),
        });
      }
      return [...records.values()];
    },
  };
}
