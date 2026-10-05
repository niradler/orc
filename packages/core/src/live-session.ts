import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const LIVE_REGISTRY_DIR = join(homedir(), ".orc", "live-sessions");
export const LiveRegistration = z.object({
  backend: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  externalId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/),
  pid: z.number().int().positive(),
  title: z.string().max(200).default("Agent session"),
  cwd: z.string().optional(),
  transcriptPath: z.string().optional(),
  status: z.enum(["running", "idle", "stopped"]),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
});
export type LiveRegistration = z.infer<typeof LiveRegistration>;

export function readRegistrations(dir: string = LIVE_REGISTRY_DIR): LiveRegistration[] {
  if (!existsSync(dir)) return [];
  const records: LiveRegistration[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = LiveRegistration.safeParse(JSON.parse(readFileSync(join(dir, name), "utf8")));
      if (parsed.success) records.push(parsed.data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError))
        throw error;
    }
  }
  return records;
}

export function writeRegistration(input: LiveRegistration, dir: string = LIVE_REGISTRY_DIR): void {
  const record = LiveRegistration.parse(input);
  mkdirSync(dir, { recursive: true });
  const name = `${record.backend}-${record.externalId}.json`;
  const temp = join(dir, `${name}.${process.pid}.${crypto.randomUUID()}.tmp`);
  writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
  renameSync(temp, join(dir, name));
}
