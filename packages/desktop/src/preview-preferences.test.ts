import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreviewPreferencesStore } from "./preview-preferences";

const directory = mkdtempSync(join(tmpdir(), "orc-browser-settings-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
test("should default browser control on, persist preferences and reject damaged configuration", () => {
  const path = join(directory, "browser.json"),
    store = new PreviewPreferencesStore(path);
  expect(store.get()).toEqual({ agentBrowserControl: true, openLinksIn: "preview" });
  store.set({ agentBrowserControl: false, openLinksIn: "system" });
  expect(new PreviewPreferencesStore(path).get()).toEqual({
    agentBrowserControl: false,
    openLinksIn: "system",
  });
  expect(() => store.set({ agentBrowserControl: true, openLinksIn: "bad" } as never)).toThrow();
  expect(store.get().agentBrowserControl).toBe(false);
  writeFileSync(path, "broken");
  expect(() => store.get()).toThrow();
  expect(store.snapshot()).toEqual({ agentBrowserControl: false, openLinksIn: "system" });
});
