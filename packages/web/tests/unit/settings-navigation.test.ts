import { describe, expect, test } from "bun:test";
import {
  CONNECTION_TABS,
  resolveSettingsTarget,
  SETTINGS_GROUP_IDS,
} from "../../src/lib/settings-navigation";

describe("settings navigation", () => {
  test("every group id resolves to its own panel", () => {
    for (const id of SETTINGS_GROUP_IDS) {
      expect(resolveSettingsTarget(id)).toEqual({ group: id });
    }
  });

  test("legacy section names keep landing on the grouped panels", () => {
    expect(resolveSettingsTarget("appearance")).toEqual({ group: "general" });
    expect(resolveSettingsTarget("terminals")).toEqual({ group: "general" });
    expect(resolveSettingsTarget("browser")).toEqual({ group: "general" });
    expect(resolveSettingsTarget("connection")).toEqual({ group: "hosts" });
    expect(resolveSettingsTarget("execution")).toEqual({ group: "hosts" });
    expect(resolveSettingsTarget("chat")).toEqual({ group: "agents", agentTab: "chat" });
    expect(resolveSettingsTarget("mcp")).toEqual({ group: "agents", agentTab: "mcp" });
    expect(resolveSettingsTarget("channels")).toEqual({
      group: "connections",
      connectionTab: "channels",
    });
    expect(resolveSettingsTarget("integrations")).toEqual({
      group: "connections",
      connectionTab: "integrations",
    });
    expect(resolveSettingsTarget("storage")).toEqual({ group: "about" });
    expect(resolveSettingsTarget("attention")).toEqual({ group: "notifications" });
  });

  test("unknown or empty sections fall back to no target", () => {
    expect(resolveSettingsTarget(null)).toBeUndefined();
    expect(resolveSettingsTarget("")).toBeUndefined();
    expect(resolveSettingsTarget("nope")).toBeUndefined();
  });

  test("connection tabs cover both panels", () => {
    expect([...CONNECTION_TABS]).toEqual(["channels", "integrations"]);
  });
});
