import { readFileSync, writeFileSync } from "node:fs";
import { type PreviewPreferences, PreviewPreferencesSchema } from "@orc/core/desktop-preview";

export class PreviewPreferencesStore {
  constructor(private readonly path: string) {}
  get(): PreviewPreferences {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT")
        return PreviewPreferencesSchema.parse({});
      throw new Error("Browser preferences could not be read");
    }
    return PreviewPreferencesSchema.parse(JSON.parse(text));
  }
  set(input: PreviewPreferences): PreviewPreferences {
    const settings = PreviewPreferencesSchema.parse(input);
    writeFileSync(this.path, JSON.stringify(settings, null, 2));
    return settings;
  }
}
