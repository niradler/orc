import { readFileSync } from "node:fs";
import { type PreviewPreferences, PreviewPreferencesSchema } from "@orc/core/desktop-preview";
import { z } from "zod";
import { writePreviewJson } from "./preview-storage.js";

const chatPreferences = z.record(z.string().max(8500), z.boolean());

/** Separate from global defaults, so resetting Browser settings preserves chat revocations. */
export class PreviewChatPreferencesStore {
  constructor(private readonly path: string) {}
  private read(): Record<string, boolean> {
    try {
      return chatPreferences.parse(JSON.parse(readFileSync(this.path, "utf8")));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error("Chat browser permissions could not be read; control stays disabled");
    }
  }
  get(origin: string, session: string): boolean {
    return this.read()[JSON.stringify([origin, session])] ?? true;
  }
  set(origin: string, session: string, enabled: boolean): boolean {
    const settings = this.read();
    settings[JSON.stringify([origin, session])] = enabled;
    writePreviewJson(this.path, settings);
    return enabled;
  }
}

export class PreviewPreferencesStore {
  private current = PreviewPreferencesSchema.parse({});
  constructor(private readonly path: string) {}
  snapshot(): PreviewPreferences {
    return { ...this.current };
  }
  get(): PreviewPreferences {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        this.current = PreviewPreferencesSchema.parse({});
        return this.snapshot();
      }
      throw new Error("Browser preferences could not be read");
    }
    this.current = PreviewPreferencesSchema.parse(JSON.parse(text));
    return this.snapshot();
  }
  set(input: PreviewPreferences): PreviewPreferences {
    const settings = PreviewPreferencesSchema.parse(input);
    writePreviewJson(this.path, settings);
    this.current = settings;
    return this.snapshot();
  }
}
