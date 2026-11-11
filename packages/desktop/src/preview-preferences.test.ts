import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreviewChatPreferencesStore, PreviewPreferencesStore } from "./preview-preferences";

test("should persist chat revocation across restart without granting another installation or chat", () => {
  const path = join(directory, "chats.json");
  const store = new PreviewChatPreferencesStore(path);
  expect(store.get("http://localhost:7702", "chat-a")).toBe(true);
  store.set("http://localhost:7702", "chat-a", false);
  const restarted = new PreviewChatPreferencesStore(path);
  expect(restarted.get("http://localhost:7702", "chat-a")).toBe(false);
  expect(restarted.get("http://localhost:7702", "chat-b")).toBe(true);
  expect(restarted.get("http://localhost:7701", "chat-a")).toBe(true);
  writeFileSync(path, "broken");
  expect(() => restarted.get("http://localhost:7702", "chat-a")).toThrow("disabled");
  expect(() => restarted.set("http://localhost:7702", "chat-a", true)).toThrow();
});

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
