import { readFileSync, writeFileSync } from "node:fs";
import { type PreviewPreferences, PreviewPreferencesSchema } from "@orc/core/desktop-preview";

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
    writeFileSync(this.path, JSON.stringify(settings, null, 2));
    this.current = settings;
    return this.snapshot();
  }
}
