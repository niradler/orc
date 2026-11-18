import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type PiLiveSession = {
  id: string;
  cwd: string;
  transcriptPath?: string | undefined;
  createdAt: number;
};

export function writePiLiveSession(
  dir: string,
  session: PiLiveSession,
  status: "running" | "idle" | "stopped",
): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `pi-${session.id}.json`);
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(
    temp,
    JSON.stringify({
      backend: "pi",
      externalId: session.id,
      pid: process.pid,
      title: "Pi session",
      cwd: session.cwd,
      ...(session.transcriptPath ? { transcriptPath: session.transcriptPath } : {}),
      status,
      createdAt: session.createdAt,
      updatedAt: Date.now(),
    }),
    { mode: 0o600 },
  );
  renameSync(temp, file);
}
