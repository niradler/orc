import { describe, expect, test } from "bun:test";
import {
  CONNECTION_TABS,
  resolveSettingsTarget,
  SETTINGS_DOMAINS,
  SETTINGS_GROUP_IDS,
  SETTINGS_GROUPS,
  settingsGroupsFor,
} from "../../src/lib/settings-navigation";

describe("settings navigation", () => {
  test("every group id resolves to its own panel", () => {
    for (const id of SETTINGS_GROUP_IDS) {
      expect(resolveSettingsTarget(id)).toEqual({ group: id });
    }
  });

  test("each group is described exactly once and belongs to one domain", () => {
    const ids = SETTINGS_GROUPS.map((group) => group.id);
    expect(ids).toEqual([...SETTINGS_GROUP_IDS]);
    expect(new Set(ids).size).toBe(ids.length);
    const domainIds = SETTINGS_DOMAINS.map((domain) => domain.id);
    for (const group of SETTINGS_GROUPS) expect(domainIds).toContain(group.domain);
    const listed = SETTINGS_DOMAINS.flatMap((domain) =>
      settingsGroupsFor(domain.id).map((group) => group.id),
    );
    expect(listed).toEqual([...SETTINGS_GROUP_IDS]);
  });

  test("legacy section names keep landing on the grouped panels", () => {
    expect(resolveSettingsTarget("appearance")).toEqual({ group: "general" });
    expect(resolveSettingsTarget("terminals")).toEqual({ group: "general" });
    expect(resolveSettingsTarget("browser")).toEqual({ group: "general" });
    expect(resolveSettingsTarget("connection")).toEqual({ group: "hosts" });
    expect(resolveSettingsTarget("execution")).toEqual({ group: "hosts" });
    expect(resolveSettingsTarget("hosts")).toEqual({ group: "hosts" });
    expect(resolveSettingsTarget("agents")).toEqual({ group: "agents" });
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
    expect(resolveSettingsTarget("knowledge")).toEqual({ group: "knowledge" });
    expect(resolveSettingsTarget("attention")).toEqual({ group: "notifications" });
    expect(resolveSettingsTarget("notifications")).toEqual({ group: "notifications" });
    expect(resolveSettingsTarget("usage")).toEqual({ group: "usage" });
    expect(resolveSettingsTarget("security")).toEqual({ group: "security" });
    expect(resolveSettingsTarget("server")).toEqual({ group: "about" });
    expect(resolveSettingsTarget("storage")).toEqual({ group: "about" });
    expect(resolveSettingsTarget("about")).toEqual({ group: "about" });
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
