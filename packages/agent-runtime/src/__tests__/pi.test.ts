import { expect, test } from "bun:test";
import { ChatAgentOptionsSchema, chatRuntime } from "@orc/core/chat-options";
import {
  codingAgent,
  supportsManualCompaction,
  supportsModelDiscovery,
} from "@orc/core/coding-agents";
import { JobActionSchema } from "@orc/core/job-actions";
import { ProviderProfileSchema } from "@orc/core/providers";
import { parseAgentModels } from "../models";

test("Pi is a native provider with validated structured options and an executable override", () => {
  expect(codingAgent("pi")?.chatRuntime).toBe("pi");
  expect(supportsModelDiscovery("pi")).toBe(true);
  expect(supportsManualCompaction("pi")).toBe(true);
  expect(chatRuntime("pi")).toBe("pi");
  expect(
    ChatAgentOptionsSchema.safeParse({
      runtime: "pi",
      options: { thinkingLevel: "high", autoCompaction: true },
    }).success,
  ).toBe(true);
  expect(
    ChatAgentOptionsSchema.safeParse({ runtime: "pi", options: { args: ["--no-extensions"] } })
      .success,
  ).toBe(false);
  expect(
    ProviderProfileSchema.safeParse({
      id: "pi",
      name: "Pi",
      agent: "pi",
      enabled: true,
      executable: "/opt/pi",
      model: "",
    }).success,
  ).toBe(true);
});

test("Pi model discovery preserves provider identity and job options use the native runtime", () => {
  expect(
    parseAgentModels(
      [
        { provider: "one", id: "shared", name: "First" },
        { provider: "two", id: "shared", name: "Second" },
        { id: "broken" },
      ],
      "pi",
    ),
  ).toEqual([
    { id: "one/shared", label: "First" },
    { id: "two/shared", label: "Second" },
  ]);
  expect(
    JobActionSchema.safeParse({
      type: "agent",
      backend: "pi",
      prompt: "Check files",
      options: { runtime: "pi", options: { thinkingLevel: "high" } },
    }).success,
  ).toBe(true);
  expect(
    JobActionSchema.safeParse({
      type: "agent",
      backend: "pi",
      prompt: "Check files",
      options: { runtime: "acpx", args: [] },
    }).success,
  ).toBe(false);
});

test("Pi resolves npm command shims to the Node entry point", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { piCommand } = await import("../pi");
  const cwd = mkdtempSync(join(tmpdir(), "orc-pi-shim-"));
  try {
    const shim = join(cwd, "pi.cmd");
    const cli = join(
      cwd,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "bundle",
      "cli.js",
    );
    mkdirSync(join(cwd, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle"), {
      recursive: true,
    });
    writeFileSync(shim, "test shim", { mode: 0o755 });
    writeFileSync(cli, "test entry");
    const node = Bun.which("node");
    if (!node) throw new Error("Pi CLI tests require Node.js");
    expect(await piCommand({ providerExecutable: shim, executionHost: null })).toEqual([node, cli]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
