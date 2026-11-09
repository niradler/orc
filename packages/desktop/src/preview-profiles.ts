import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type PreviewProfile,
  PreviewProfileSchema,
  previewWebUrl,
} from "@orc/core/desktop-preview";
import { z } from "zod";
import { writePreviewJson } from "./preview-storage.js";

const configuration = z
  .object({
    profiles: z.array(PreviewProfileSchema).max(32),
    selections: z.record(z.string().max(8500), z.string().uuid().nullable()),
    workspaces: z
      .record(
        z.string().max(8500),
        z.object({
          selected: z.string().uuid(),
          tabs: z
            .array(
              z.object({
                id: z.string().uuid(),
                url: z
                  .string()
                  .max(8192)
                  .refine((value) => previewWebUrl(value) !== null),
              }),
            )
            .min(1)
            .max(8),
        }),
      )
      .default({}),
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
        return { profiles: [], selections: {}, workspaces: {} };
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
  rename(id: string, name: string): PreviewProfile {
    const state = this.read();
    const index = state.profiles.findIndex(
      (profile) => profile.id === id && profile.origin === this.origin,
    );
    if (index < 0) throw new Error("Unknown browser profile");
    const profile = PreviewProfileSchema.parse({ id, name, origin: this.origin });
    state.profiles[index] = profile;
    writePreviewJson(this.path, state);
    return profile;
  }
  remove(id: string): void {
    const state = this.read();
    if (!state.profiles.some((profile) => profile.id === id && profile.origin === this.origin))
      throw new Error("Unknown browser profile");
    state.profiles = state.profiles.filter((profile) => profile.id !== id);
    for (const [key, selected] of Object.entries(state.selections))
      if (selected === id) {
        state.selections[key] = null;
        delete state.workspaces[key];
      }
    writePreviewJson(this.path, state);
  }
  workspace(session: string): { selected: string; tabs: { id: string; url: string }[] } | null {
    return this.read().workspaces[JSON.stringify([this.origin, session])] ?? null;
  }
  saveWorkspace(
    session: string,
    workspace: { selected: string; tabs: { id: string; url: string }[] } | null,
  ): void {
    const state = this.read(),
      key = JSON.stringify([this.origin, session]);
    if (workspace) {
      if (!state.workspaces[key] && Object.keys(state.workspaces).length >= 128)
        throw new Error("Browser session storage is full. Close saved tabs in an unused chat.");
      state.workspaces[key] = workspace;
    } else delete state.workspaces[key];
    writePreviewJson(this.path, configuration.parse(state));
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
