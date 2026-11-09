import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { type PreviewProfile, PreviewProfileSchema } from "@orc/core/desktop-preview";
import { z } from "zod";
import { writePreviewJson } from "./preview-storage.js";

const configuration = z
  .object({
    profiles: z.array(PreviewProfileSchema).max(32),
    selections: z.record(z.string().max(8500), z.string().uuid().nullable()),
  })
  .strict();

/** Metadata only. Chromium owns encrypted cookies and site storage in separate partitions. */
export class PreviewProfiles {
  constructor(
    private readonly path: string,
    private readonly origin: string,
  ) {}
  private read(): z.infer<typeof configuration> {
    try {
      return configuration.parse(JSON.parse(readFileSync(this.path, "utf8")));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT")
        return { profiles: [], selections: {} };
      throw new Error("Browser profiles could not be read. Your existing profiles were preserved.");
    }
  }
  list(): PreviewProfile[] {
    return this.read().profiles.filter((profile) => profile.origin === this.origin);
  }
  create(name: string): PreviewProfile {
    const state = this.read();
    if (state.profiles.length >= 32) throw new Error("At most 32 browser profiles are supported");
    const profile = PreviewProfileSchema.parse({ id: randomUUID(), name, origin: this.origin });
    state.profiles.push(profile);
    writePreviewJson(this.path, state);
    return profile;
  }
  selected(session: string): string | null {
    const state = this.read();
    const id = state.selections[JSON.stringify([this.origin, session])] ?? null;
    if (
      id &&
      !state.profiles.some((profile) => profile.id === id && profile.origin === this.origin)
    )
      throw new Error("The selected browser profile is unavailable");
    return id;
  }
  select(session: string, id: string | null): void {
    const state = this.read();
    if (
      id &&
      !state.profiles.some((profile) => profile.id === id && profile.origin === this.origin)
    )
      throw new Error("Browser profile is outside this ORC installation");
    state.selections[JSON.stringify([this.origin, session])] = id;
    writePreviewJson(this.path, state);
  }
  partition(profileId: string): string {
    if (!this.list().some((profile) => profile.id === profileId))
      throw new Error("Unknown browser profile");
    return `persist:orc-browser-${createHash("sha256").update(this.origin).digest("hex").slice(0, 24)}-${profileId}`;
  }
}
