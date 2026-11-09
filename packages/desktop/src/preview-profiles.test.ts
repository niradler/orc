import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreviewProfiles } from "./preview-profiles.js";

const directory = mkdtempSync(join(tmpdir(), "orc-preview-profiles-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
test("should persist explicit per-chat profiles, keep temporary defaults and reject cross-installation selection", () => {
  const path = join(directory, "profiles.json");
  const store = new PreviewProfiles(path, "http://localhost:7702");
  expect(store.selected("a")).toBeNull();
  const profile = store.create("Work");
  store.select("a", profile.id);
  const restarted = new PreviewProfiles(path, "http://localhost:7702");
  expect(restarted.selected("a")).toBe(profile.id);
  expect(restarted.selected("b")).toBeNull();
  expect(restarted.partition(profile.id)).toStartWith("persist:orc-browser-");
  const other = new PreviewProfiles(path, "http://localhost:7701");
  expect(other.list()).toEqual([]);
  expect(() => other.select("a", profile.id)).toThrow();
  expect(() => other.partition(profile.id)).toThrow();
  restarted.select("b", profile.id);
  expect(restarted.selected("b")).toBe(profile.id);
  restarted.select("a", null);
  expect(restarted.selected("a")).toBeNull();
  writeFileSync(path, "broken");
  expect(() => restarted.list()).toThrow("preserved");
});
