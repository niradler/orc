import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localAgentBinary, resetConfig, updateGlobalConfig } from "./config.js";
import { hostBinary } from "./exec-host.js";
import { resolvePackageAgentBinary } from "./package-launch.js";

const directory = mkdtempSync(join(tmpdir(), "orc-provider-paths-"));
const previousHome = process.env.HOME;
const previousProfile = process.env.USERPROFILE;
beforeAll(() => {
  process.env.HOME = directory;
  process.env.USERPROFILE = directory;
  resetConfig();
});
afterAll(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousProfile;
  resetConfig();
  rmSync(directory, { recursive: true, force: true });
});

test("should share local executable overrides across native and package/terminal lookup", async () => {
  updateGlobalConfig((raw) => {
    raw.preferences = { provider_paths: { codex: process.execPath, claude: process.execPath } };
  });
  expect(localAgentBinary("claude")).toBe(process.execPath);
  expect(await hostBinary({ kind: "local" }, "codex")).toBe(process.execPath);
  expect(resolvePackageAgentBinary("codex")).toBe(process.execPath);
  updateGlobalConfig((raw) => {
    raw.preferences = { provider_paths: { codex: join(directory, "missing; command.exe") } };
  });
  expect(localAgentBinary("codex")).toBeNull();
  updateGlobalConfig((raw) => {
    raw.preferences = { provider_paths: { codex: "" } };
  });
  expect(localAgentBinary("codex")).toBe(Bun.which("codex", { PATH: process.env.PATH ?? "" }));
});
