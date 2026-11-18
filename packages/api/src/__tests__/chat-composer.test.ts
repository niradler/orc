import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@orc/core/config";
import { setupTestApp, teardownTestApp } from "./helpers";

let app: ReturnType<typeof setupTestApp>;
let root: string;
let cwd: string;
const get = (path: string, auth = true) =>
  app.request(`/api${path}`, auth ? { headers: { Authorization: "Bearer test-secret" } } : {});
const files = (query: string) =>
  get(`/chat/files?host=__local__&cwd=${encodeURIComponent(cwd)}&${query}`);

beforeAll(() => {
  app = setupTestApp();
  root = mkdtempSync(join(tmpdir(), "orc-chat-composer-"));
  cwd = join(root, "repo");
  mkdirSync(join(cwd, "src", "api"), { recursive: true });
  writeFileSync(join(cwd, "src", "app.ts"), "");
  mkdirSync(join(root, "outside"));
  writeFileSync(join(root, "outside", "secret.txt"), "");
  symlinkSync(join(root, "outside"), join(cwd, "escape"));
});

afterAll(() => {
  teardownTestApp();
  rmSync(root, { recursive: true, force: true });
});

test("files lists one folder under the working directory and rejects paths that leave it", async () => {
  expect((await get("/chat/files?path=src", false)).status).toBe(401);
  const listed = await files("path=src");
  expect(listed.status).toBe(200);
  expect(await listed.json()).toEqual({
    entries: [
      { name: "api", directory: true },
      { name: "app.ts", directory: false },
    ],
  });
  for (const path of ["..", "src/../..", "../outside", "/etc", "src/\0"])
    expect((await files(`path=${encodeURIComponent(path)}`)).status).toBe(400);
  expect((await files("path=missing")).status).toBe(400);
  expect((await files("path=src&host=-bad")).status).toBe(400);
  expect(
    (await get("/chat/files?path=&threadId=00000000-0000-4000-8000-000000000999")).status,
  ).toBe(404);
});

test("files follows a folder link the user placed inside the working directory", async () => {
  expect(await (await files("path=escape")).json()).toEqual({
    entries: [{ name: "secret.txt", directory: false }],
  });
});

test("commands validate input, warn when discovery fails, and retry on the next request", async () => {
  expect((await get("/chat/commands?agent=claude", false)).status).toBe(401);
  expect((await get("/chat/commands?agent=--bad")).status).toBe(400);
  expect(await (await get("/chat/commands?agent=gemini&host=__local__")).json()).toEqual({
    commands: [],
    warning: null,
  });
  // Windows resolves executables by PATHEXT and cannot spawn a bare shebang
  // script, so the fixture mirrors the real Claude Code install there: a .cmd
  // shim beside node_modules/@anthropic-ai/claude-code/cli.js, which the SDK
  // launch resolver runs with node/bun instead of the shell shim.
  const win = process.platform === "win32";
  const executable = join(root, win ? "claude-fixture.cmd" : "claude-fixture");
  const config = loadConfig();
  const original = config.providers;
  config.providers = {
    instances: [
      {
        id: "claude-commands-fixture",
        name: "Fixture",
        agent: "claude",
        enabled: true,
        executable,
        model: "",
        environment: [],
      },
    ],
    default_id: "claude-commands-fixture",
  };
  const commands = () =>
    get(
      `/chat/commands?agent=claude&providerId=claude-commands-fixture&host=__local__&cwd=${encodeURIComponent(cwd)}`,
    );
  try {
    expect(await (await commands()).json()).toEqual({
      commands: [],
      warning: "Agent commands unavailable",
    });
    // Runs under both node and bun: the Windows launch resolver picks whichever
    // interpreter is on PATH, while the POSIX shebang chooses bun.
    const payload = `let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const m = JSON.parse(line);
    console.log(JSON.stringify({ type: "control_response", response: { request_id: m.request_id, subtype: "success", response: { commands: [{ name: "code-review", description: "Review the diff", argumentHint: "", aliases: ["review"] }] } } }));
  }
});
`;
    if (win) {
      const cliDir = join(root, "node_modules", "@anthropic-ai", "claude-code");
      mkdirSync(cliDir, { recursive: true });
      writeFileSync(join(cliDir, "cli.js"), payload);
      writeFileSync(
        executable,
        `@echo off\r\nbun "%~dp0node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n`,
      );
    } else {
      writeFileSync(executable, `#!/usr/bin/env bun\n${payload}`);
      chmodSync(executable, 0o755);
    }
    expect(await (await commands()).json()).toEqual({
      commands: [
        {
          name: "code-review",
          token: "/code-review",
          description: "Review the diff",
          argumentHint: "",
          aliases: ["review"],
          source: "claude",
        },
      ],
      warning: null,
    });
  } finally {
    config.providers = original;
  }
});
