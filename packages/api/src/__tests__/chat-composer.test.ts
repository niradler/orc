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
  const executable = join(root, "claude-fixture");
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
        environment: [],
      },
    ],
    default_id: "claude-commands-fixture",
  } as typeof config.providers;
  const commands = () =>
    get(
      `/chat/commands?agent=claude&providerId=claude-commands-fixture&host=__local__&cwd=${encodeURIComponent(cwd)}`,
    );
  try {
    expect(await (await commands()).json()).toEqual({
      commands: [],
      warning: "Agent commands unavailable",
    });
    writeFileSync(
      executable,
      `#!/usr/bin/env bun\nfor await (const chunk of Bun.stdin.stream()) { const m = JSON.parse(new TextDecoder().decode(chunk)); console.log(JSON.stringify({ type: "control_response", response: { request_id: m.request_id, subtype: "success", response: { commands: [{ name: "code-review", description: "Review the diff", argumentHint: "", aliases: ["review"] }] } } })); }\n`,
    );
    chmodSync(executable, 0o755);
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
