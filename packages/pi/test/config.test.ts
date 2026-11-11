import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPorcConfig,
  normalizeApiBase,
  PorcConfigError,
  porcPaths,
  projectArgs,
  resolveApiBase,
} from "../src/config.js";

const roots: string[] = [];

function workspace(): { home: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), "porc-config-"));
  roots.push(root);
  const home = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { home, cwd };
}

function write(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("loadPorcConfig", () => {
  test("uses loopback defaults when nothing is configured", () => {
    const { home, cwd } = workspace();
    const config = loadPorcConfig({ cwd, home, env: {} });

    expect(config).toMatchObject({
      enabled: true,
      apiBase: "http://127.0.0.1:7700",
      transport: "stdio",
      autoProject: true,
      askProject: true,
      autoContext: true,
      systemPrompt: true,
      rules: true,
      timeoutMs: 5000,
      command: "orc",
    });
    expect(config.secret).toBeUndefined();
    expect(config.project).toBeUndefined();
  });

  test("reads the ORC host, port and secret", () => {
    const { home, cwd } = workspace();
    write(join(home, ".orc", "config.json"), {
      api: { host: "0.0.0.0", port: 7800, secret: " from-orc " },
    });
    const config = loadPorcConfig({ cwd, home, env: {} });

    expect(config.apiBase).toBe("http://127.0.0.1:7800");
    expect(config.secret).toBe("from-orc");
    expect(config.secretSource).toBe("orc");
  });

  test("merges user and trusted project config, then applies environment overrides", () => {
    const { home, cwd } = workspace();
    write(join(home, ".pi", "agent", "porc.json"), {
      apiBase: "http://127.0.0.1:7000/api/",
      transport: "http",
      project: "user-project",
      autoContext: true,
    });
    write(join(cwd, ".pi", "porc.json"), {
      autoContext: false,
      askProject: false,
      project: "project-project",
      recall: { maxSkills: 1 },
    });
    write(join(home, ".orc", "config.json"), { api: { secret: "orc-secret" } });

    const config = loadPorcConfig({
      cwd,
      home,
      projectTrusted: true,
      env: {
        PORC_MCP_TRANSPORT: "stdio",
        PORC_API_BASE: "http://0.0.0.0:7100/api",
        PORC_PROJECT: "env-project",
        PORC_API_SECRET: "env-secret",
      },
    });

    expect(config.apiBase).toBe("http://127.0.0.1:7100");
    expect(config.transport).toBe("stdio");
    expect(config.project).toBe("env-project");
    expect(config.autoContext).toBe(false);
    expect(config.askProject).toBe(false);
    expect(config.secret).toBe("env-secret");
    expect(config.secretSource).toBe("env");
    expect(config.recall.maxSkills).toBe(1);
    expect(config.recall.maxMemories).toBe(4);
  });

  test("recall and rules default on, and env switches them", () => {
    const { home, cwd } = workspace();
    const defaults = loadPorcConfig({ cwd, home, env: {} });
    expect(defaults.recall.enabled).toBe(true);
    expect(defaults.rules).toBe(true);
    const tuned = loadPorcConfig({
      cwd,
      home,
      env: { PORC_RECALL: "false", PORC_RULES: "off", PORC_ASK_PROJECT: "no" },
    });
    expect(tuned.recall.enabled).toBe(false);
    expect(tuned.rules).toBe(false);
    expect(tuned.askProject).toBe(false);
    expect(() => loadPorcConfig({ cwd, home, env: { PORC_RULES: "maybe" } })).toThrow();
  });

  test("rejects removed skill and MCP mode settings", () => {
    const { home, cwd } = workspace();
    write(join(home, ".pi", "agent", "porc.json"), { skills: { mode: "all" } });
    expect(() => loadPorcConfig({ cwd, home, env: {} })).toThrow(PorcConfigError);
  });

  test("ignores project config until the project is trusted", () => {
    const { home, cwd } = workspace();
    write(join(cwd, ".pi", "porc.json"), { project: "secret-project", autoContext: false });

    const untrusted = loadPorcConfig({ cwd, home, env: {} });
    expect(untrusted.project).toBeUndefined();
    expect(untrusted.autoContext).toBe(true);

    const trusted = loadPorcConfig({ cwd, home, projectTrusted: true, env: {} });
    expect(trusted.project).toBe("secret-project");
    expect(trusted.autoContext).toBe(false);
  });

  test("flags win over environment and files", () => {
    const { home, cwd } = workspace();
    write(join(home, ".pi", "agent", "porc.json"), { apiBase: "http://127.0.0.1:7000" });
    const config = loadPorcConfig({
      cwd,
      home,
      env: { PORC_API_BASE: "http://127.0.0.1:7100", PORC_CONTEXT: "true" },
      overrides: {
        apiBase: "http://127.0.0.1:7200",
        project: "flag-project",
        autoContext: false,
        recall: false,
        rules: false,
      },
    });

    expect(config.apiBase).toBe("http://127.0.0.1:7200");
    expect(config.project).toBe("flag-project");
    expect(config.autoContext).toBe(false);
    expect(config.recall.enabled).toBe(false);
    expect(config.rules).toBe(false);
  });

  test("PORC_DISABLED disables the integration", () => {
    const { home, cwd } = workspace();
    expect(loadPorcConfig({ cwd, home, env: { PORC_DISABLED: "yes" } }).enabled).toBe(false);
    expect(loadPorcConfig({ cwd, home, env: { PORC_DISABLED: "0" } }).enabled).toBe(true);
  });

  test("a named secret environment variable is used when PORC_API_SECRET is absent", () => {
    const { home, cwd } = workspace();
    write(join(home, ".pi", "agent", "porc.json"), { secretEnv: "MY_ORC_TOKEN" });
    const config = loadPorcConfig({
      cwd,
      home,
      env: { MY_ORC_TOKEN: "named-secret", ORC_API_SECRET: "inherited" },
    });

    expect(config.secret).toBe("named-secret");
    expect(config.secretSource).toBe("file");
  });

  test("inherits ORC_API_SECRET when no porc secret is configured", () => {
    const { home, cwd } = workspace();
    const config = loadPorcConfig({ cwd, home, env: { ORC_API_SECRET: "inherited" } });
    expect(config.secret).toBe("inherited");
    expect(config.secretSource).toBe("env");
  });

  test("rejects invalid files and environment values", () => {
    const { home, cwd } = workspace();
    write(join(home, ".pi", "agent", "porc.json"), { unknownKey: true });
    expect(() => loadPorcConfig({ cwd, home, env: {} })).toThrow(PorcConfigError);

    const good = workspace();
    expect(() =>
      loadPorcConfig({
        cwd: good.cwd,
        home: good.home,
        env: { PORC_MCP_TRANSPORT: "carrier-pigeon" },
      }),
    ).toThrow(PorcConfigError);
  });
});

describe("API base normalization", () => {
  test("strips /api, trailing slashes and wildcard hosts", () => {
    expect(normalizeApiBase("http://0.0.0.0:7700/api/")).toBe("http://127.0.0.1:7700");
    expect(normalizeApiBase("https://orc.example.com/base/")).toBe("https://orc.example.com/base");
    expect(normalizeApiBase("http://[::]:7700")).toBe("http://127.0.0.1:7700");
  });

  test("rejects invalid URLs", () => {
    expect(() => normalizeApiBase("not a url")).toThrow(PorcConfigError);
    expect(() => normalizeApiBase("ftp://127.0.0.1:7700")).toThrow(PorcConfigError);
  });

  test("falls back to the ORC host and port", () => {
    expect(resolveApiBase({ orc: { host: "0.0.0.0", port: 7800 } })).toBe("http://127.0.0.1:7800");
    expect(resolveApiBase({ orc: { host: "::1", port: 7801 } })).toBe("http://[::1]:7801");
    expect(resolveApiBase({ configured: "http://orc.local:9000/api/" })).toBe(
      "http://orc.local:9000",
    );
    expect(
      resolveApiBase({
        configured: "http://127.0.0.1:7000",
        env: "http://127.0.0.1:7100/",
      }),
    ).toBe("http://127.0.0.1:7100");
  });
});

test("projectArgs omits an unset project", () => {
  expect(projectArgs(undefined)).toEqual({});
  expect(projectArgs("orc")).toEqual({ project: "orc" });
});

test("porcPaths keeps user and project configuration separate", () => {
  const paths = porcPaths({ cwd: "C:/work/app", home: "C:/Users/me" });
  expect(paths.userFile).toBe(join("C:/Users/me", ".pi", "agent", "porc.json"));
  expect(paths.projectFile).toBe(join("C:/work/app", ".pi", "porc.json"));
  expect(paths.orcFile).toBe(join("C:/Users/me", ".orc", "config.json"));
  expect(paths.choicesFile).toBe(join("C:/Users/me", ".pi", "agent", "porc-projects.json"));
});
