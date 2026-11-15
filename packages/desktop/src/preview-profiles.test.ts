import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreviewProfiles } from "./preview-profiles.js";

const directory = mkdtempSync(join(tmpdir(), "orc-preview-profiles-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
test("should default every chat to the shared ORC profile and keep selections across daemon ports", () => {
  const path = join(directory, "profiles.json");
  const store = new PreviewProfiles(path, "http://localhost:7702");
  expect(store.selected("a")).toBe("default");
  expect(store.partition("default")).toBe("persist:orc-browser-default");
  const profile = store.create("Work");
  store.select("a", profile.id);
  store.select("c", "temporary");
  const restarted = new PreviewProfiles(path, "http://localhost:7702");
  expect(restarted.selected("a")).toBe(profile.id);
  expect(restarted.selected("b")).toBe("default");
  expect(restarted.selected("c")).toBe("temporary");
  const partition = restarted.partition(profile.id);
  expect(partition).toStartWith("persist:orc-browser-");
  const moved = new PreviewProfiles(path, "http://localhost:7701");
  expect(moved.list()).toEqual([profile]);
  expect(moved.selected("a")).toBe(profile.id);
  expect(moved.partition(profile.id)).toBe(partition);
  expect(() => moved.select("a", crypto.randomUUID())).toThrow("Unknown browser profile");
  restarted.select("b", profile.id);
  const tab = crypto.randomUUID();
  restarted.saveWorkspace("b", {
    selected: tab,
    tabs: [{ id: tab, url: "https://example.com/account" }],
  });
  expect(moved.workspace("b")?.selected).toBe(tab);
  expect(moved.rename(profile.id, "Renamed")).toEqual({ ...profile, name: "Renamed" });
  restarted.remove(profile.id);
  expect(restarted.selected("b")).toBe("default");
  expect(restarted.workspace("b")).toBeNull();
  expect(restarted.list()).toEqual([]);
  expect(() => restarted.partition(profile.id)).toThrow();
  restarted.select("c", "default");
  expect(restarted.selected("c")).toBe("default");
  writeFileSync(path, "broken");
  expect(() => restarted.list()).toThrow("preserved");
});

test("should read selections and workspaces saved under the old origin-scoped keys", () => {
  const path = join(directory, "legacy.json");
  const id = crypto.randomUUID(),
    tab = crypto.randomUUID();
  const key = JSON.stringify(["http://localhost:7700", "chat"]);
  writeFileSync(
    path,
    JSON.stringify({
      profiles: [{ id, name: "Work", origin: "http://localhost:7700" }],
      selections: { [key]: id, [JSON.stringify(["http://localhost:7700", "old"])]: null },
      workspaces: { [key]: { selected: tab, tabs: [{ id: tab, url: "https://example.com" }] } },
    }),
  );
  const store = new PreviewProfiles(path, "http://localhost:7700");
  expect(store.selected("chat")).toBe(id);
  expect(store.selected("old")).toBe("default");
  expect(store.workspace("chat")?.selected).toBe(tab);
  store.select("chat", "temporary");
  expect(new PreviewProfiles(path, "http://localhost:7700").selected("chat")).toBe("temporary");
});
