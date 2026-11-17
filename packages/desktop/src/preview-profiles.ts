import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  PreviewBuiltinProfileSchema,
  type PreviewProfile,
  type PreviewProfileChoice,
  PreviewProfileSchema,
  previewWebUrl,
} from "@orc/core/desktop-preview";
import { z } from "zod";
import { writePreviewJson } from "./preview-storage.js";

const configuration = z
  .object({
    profiles: z.array(PreviewProfileSchema).max(32),
    selections: z
      .record(
        z.string().max(8500),
        z.union([PreviewBuiltinProfileSchema, z.string().uuid()]).nullable(),
      )
      .default({}),
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
  private legacy(session: string): string {
    return JSON.stringify([this.origin, session]);
  }
  list(): PreviewProfile[] {
    return this.read().profiles;
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
    const index = state.profiles.findIndex((profile) => profile.id === id);
    if (index < 0) throw new Error("Unknown browser profile");
    const profile = PreviewProfileSchema.parse({ ...state.profiles[index], name });
    state.profiles[index] = profile;
    writePreviewJson(this.path, state);
    return profile;
  }
  remove(id: string): void {
    const state = this.read();
    if (!state.profiles.some((profile) => profile.id === id))
      throw new Error("Unknown browser profile");
    state.profiles = state.profiles.filter((profile) => profile.id !== id);
    for (const [key, selected] of Object.entries(state.selections))
      if (selected === id) {
        delete state.selections[key];
        delete state.workspaces[key];
      }
    writePreviewJson(this.path, state);
  }
  workspace(session: string): { selected: string; tabs: { id: string; url: string }[] } | null {
    const { workspaces } = this.read();
    return workspaces[session] ?? workspaces[this.legacy(session)] ?? null;
  }
  saveWorkspace(
    session: string,
    workspace: { selected: string; tabs: { id: string; url: string }[] } | null,
  ): void {
    const state = this.read();
    delete state.workspaces[this.legacy(session)];
    if (workspace) {
      if (!state.workspaces[session] && Object.keys(state.workspaces).length >= 128)
        throw new Error("Browser session storage is full. Close saved tabs in an unused chat.");
      state.workspaces[session] = workspace;
    } else delete state.workspaces[session];
    writePreviewJson(this.path, configuration.parse(state));
  }
  selected(session: string): PreviewProfileChoice {
    const state = this.read();
    const id = state.selections[session] ?? state.selections[this.legacy(session)];
    if (id === "temporary") return id;
    if (id && state.profiles.some((profile) => profile.id === id)) return id;
    return "default";
  }
  select(session: string, choice: PreviewProfileChoice): void {
    const state = this.read();
    if (
      !PreviewBuiltinProfileSchema.safeParse(choice).success &&
      !state.profiles.some((profile) => profile.id === choice)
    )
      throw new Error("Unknown browser profile");
    delete state.selections[this.legacy(session)];
    if (choice === "default") delete state.selections[session];
    else state.selections[session] = choice;
    writePreviewJson(this.path, state);
  }
  partition(choice: Exclude<PreviewProfileChoice, "temporary">): string {
    if (choice === "default") return "persist:orc-browser-default";
    const profile = this.list().find((profile) => profile.id === choice);
    if (!profile) throw new Error("Unknown browser profile");
    return `persist:orc-browser-${createHash("sha256").update(profile.origin).digest("hex").slice(0, 24)}-${profile.id}`;
  }
}
