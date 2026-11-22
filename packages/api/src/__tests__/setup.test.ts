import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSqlite } from "@orc/db/client";
import {
  readSetupAgents,
  type SetupAgentStatus,
  type SetupDeps,
  suggestedProjectName,
  suggestSetupProjects,
} from "../setup-status.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

// --- Agent detection with fake dependencies ---------------------------------

const home = mkdtempSync(join(tmpdir(), "orc-setup-home-"));
const oldHome = process.env.HOME;
const oldProfile = process.env.USERPROFILE;
const oldClaudeHome = process.env.CLAUDE_CONFIG_DIR;
const oldCodexHome = process.env.CODEX_HOME;

beforeAll(() => {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
});
afterAll(() => {
  for (const [key, value] of [
    ["HOME", oldHome],
    ["USERPROFILE", oldProfile],
    ["CLAUDE_CONFIG_DIR", oldClaudeHome],
    ["CODEX_HOME", oldCodexHome],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
}

function fakeDeps(overrides: Partial<SetupDeps> = {}): SetupDeps {
  return {
    home,
    platform: "linux",
    env: {},
    findBinary: () => null,
    exec: async () => ({ code: 1, stdout: "" }),
    read: async () => {
      throw new Error("missing");
    },
    ...overrides,
  };
}

const installed =
  (paths: Record<string, string>) =>
  (name: string): string | null =>
    paths[name] ?? null;

function byAgent(rows: SetupAgentStatus[], agent: string): SetupAgentStatus {
  const row = rows.find((entry) => entry.agent === agent);
  if (!row) throw new Error(`no row for ${agent}`);
  return row;
}

const codexIdToken = (email: string) =>
  `header.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.signature`;

describe("readSetupAgents", () => {
  test("lists installed agents with sign-in state, version and account label", async () => {
    writeJson(join(home, ".claude.json"), {
      oauthAccount: { emailAddress: "claude@example.com", organizationName: "Acme" },
    });
    writeJson(join(home, ".codex", "auth.json"), {
      tokens: { access_token: "private-token", id_token: codexIdToken("codex@example.com") },
    });
    writeJson(join(home, ".local", "share", "opencode", "auth.json"), {
      anthropic: { type: "api_key", key: "sk-opencode" },
    });
    const versions: Record<string, string> = {
      "/bin/claude": "2.0.15 (Claude Code)",
      "/bin/codex": "codex-cli 0.45.0",
      "/bin/opencode": "0.16.0",
    };
    const rows = await readSetupAgents(
      fakeDeps({
        findBinary: installed({
          claude: "/bin/claude",
          codex: "/bin/codex",
          opencode: "/bin/opencode",
        }),
        exec: async (argv) => ({ code: 0, stdout: versions[argv[0] ?? ""] ?? "" }),
        read: (path) => Bun.file(path).text(),
      }),
    );
    expect(rows.map((row) => row.agent)).toEqual(["claude", "codex", "opencode", "pi", "cursor"]);

    const claude = byAgent(rows, "claude");
    expect(claude).toMatchObject({
      installed: true,
      path: "/bin/claude",
      version: "2.0.15",
      signed_in: true,
      account_label: "claude@example.com",
      fix: null,
    });
    const codex = byAgent(rows, "codex");
    expect(codex).toMatchObject({ installed: true, version: "0.45.0", signed_in: true, fix: null });
    expect(codex.account_label).toBe("codex@example.com");
    expect(JSON.stringify(rows)).not.toContain("private-token");
    expect(byAgent(rows, "opencode")).toMatchObject({
      installed: true,
      version: "0.16.0",
      signed_in: true,
      fix: null,
    });
  });

  test("offers an install fix for a missing agent and a sign-in fix for a signed-out one", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "orc-setup-signedout-"));
    try {
      const rows = await readSetupAgents(
        fakeDeps({
          home: fresh,
          findBinary: installed({ claude: "/bin/claude" }),
          exec: async () => ({ code: 0, stdout: "2.0.15 (Claude Code)" }),
        }),
      );
      expect(byAgent(rows, "claude")).toMatchObject({
        installed: true,
        signed_in: false,
        fix: { label: "Sign in to Claude Code", command: "claude" },
      });
      expect(byAgent(rows, "pi")).toMatchObject({
        installed: false,
        signed_in: null,
        fix: { label: "Install Pi", command: "npm i -g @earendil-works/pi-coding-agent" },
      });
      expect(byAgent(rows, "cursor").fix?.command).toBe(
        "curl https://cursor.com/install -fsS | bash",
      );
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  test("treats API key environment variables as signed in", async () => {
    const rows = await readSetupAgents(
      fakeDeps({
        env: { ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-openai", CURSOR_API_KEY: "ckey" },
        findBinary: installed({
          claude: "/bin/claude",
          codex: "/bin/codex",
          "cursor-agent": "/bin/cursor-agent",
        }),
      }),
    );
    expect(byAgent(rows, "claude")).toMatchObject({ signed_in: true, account_label: null });
    expect(byAgent(rows, "codex")).toMatchObject({ signed_in: true });
    expect(byAgent(rows, "cursor")).toMatchObject({ installed: true, signed_in: true, fix: null });
  });

  test("reports an unknown sign-in state for Cursor on macOS without a credential file", async () => {
    const rows = await readSetupAgents(
      fakeDeps({
        platform: "darwin",
        findBinary: installed({ "cursor-agent": "/bin/cursor-agent" }),
      }),
    );
    expect(byAgent(rows, "cursor")).toMatchObject({ installed: true, signed_in: null, fix: null });
  });

  test("keeps version null when --version fails and ignores an empty OpenCode auth file", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "orc-setup-empty-"));
    try {
      writeJson(join(fresh, ".local", "share", "opencode", "auth.json"), {});
      const rows = await readSetupAgents(
        fakeDeps({
          home: fresh,
          findBinary: installed({ claude: "/bin/claude", opencode: "/bin/opencode" }),
          exec: async (argv) =>
            argv[0] === "/bin/claude" ? { code: 1, stdout: "boom" } : { code: 0, stdout: "0.16.0" },
          read: (path) => Bun.file(path).text(),
        }),
      );
      expect(byAgent(rows, "claude").version).toBeNull();
      expect(byAgent(rows, "opencode")).toMatchObject({
        signed_in: false,
        fix: { label: "Sign in to OpenCode", command: "opencode auth login" },
      });
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

test("suggestedProjectName produces a name POST /projects accepts", () => {
  expect(suggestedProjectName("/home/nir/My Project!")).toBe("My-Project");
  expect(suggestedProjectName("C:\\Projects\\orc")).toBe("orc");
  expect(suggestedProjectName("///")).toBe("project");
});

// --- Suggestions from discovered session history -----------------------------

describe("suggestSetupProjects", () => {
  let app: ReturnType<typeof setupTestApp>;
  const root = mkdtempSync(join(tmpdir(), "orc-setup-suggest-"));
  const repoA = join(root, "repoA");
  const repoAClone = join(root, "clone", "repoA");
  const plainB = join(root, "My Project!");
  const missing = join(root, "gone");

  beforeAll(() => {
    app = setupTestApp();
    mkdirSync(join(repoA, "packages", "web"), { recursive: true });
    mkdirSync(repoAClone, { recursive: true });
    mkdirSync(plainB, { recursive: true });
    for (const dir of [repoA, repoAClone]) {
      const init = Bun.spawnSync(["git", "init", dir]);
      expect(init.exitCode).toBe(0);
    }
    const db = getSqlite();
    db.prepare("INSERT INTO projects (id, name) VALUES ('p-setup-existing', 'existing')").run();
    const seed = (
      id: string,
      backend: string,
      cwd: string | null,
      lastActivity: number,
      extra: { host?: string | null; projectId?: string | null } = {},
    ) =>
      db
        .prepare(
          `INSERT INTO gateway_sessions
             (id, chat_id, backend, mode, runtime_session_id, cwd, execution_host, project_id, last_activity_at, created_at)
           VALUES (?, '__live-sessions__', ?, 'direct', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          backend,
          `native-${id}`,
          cwd,
          extra.host ?? null,
          extra.projectId ?? null,
          lastActivity,
          lastActivity,
        );
    // Two agents in one repository (one in a subfolder, one at the root) merge into one suggestion.
    seed("s1", "claude", join(repoA, "packages", "web"), 200);
    seed("s2", "codex", repoA, 300);
    // Newest activity wins the ordering.
    seed("s3", "opencode", plainB, 400);
    // A folder that no longer exists is not a useful project.
    seed("s4", "claude", missing, 500);
    // Remote sessions describe another machine's folders.
    seed("s5", "pi", plainB, 900, { host: "lab" });
    // A session that already belongs to a project is not a suggestion.
    seed("s6", "codex", repoAClone, 100, { projectId: "p-setup-existing" });
    // The cursor-agent backend reports under its agent id.
    seed("s7", "cursor-agent", repoAClone, 150);
  });

  afterAll(() => {
    teardownTestApp();
    rmSync(root, { recursive: true, force: true });
  });

  test("suggests repositories from local session history, newest first, merged per repo root", async () => {
    const suggestions = await suggestSetupProjects();
    expect(suggestions.map((entry) => entry.name)).toEqual(["My-Project", "repoA", "repoA-2"]);
    const [first, merged, clone] = suggestions;
    if (!first || !merged || !clone) throw new Error("expected three suggestions");
    // Git reports its roots with forward slashes; a non-git folder keeps the native
    // separators. Both are the same folder, so compare on the normalized form.
    const norm = (value: string) => value.replace(/\\/g, "/").toLowerCase();

    expect(norm(first.path)).toBe(norm(plainB));
    expect(first).toMatchObject({ agents: ["opencode"], sessions: 1 });
    expect(first.last_activity_at).toBe(new Date(400 * 1000).toISOString());

    expect(norm(merged.path)).toBe(norm(repoA));
    expect(merged).toMatchObject({ agents: ["claude", "codex"], sessions: 2 });
    expect(merged.last_activity_at).toBe(new Date(300 * 1000).toISOString());

    // Same basename in another folder keeps a valid, unique project name.
    expect(clone).toMatchObject({ name: "repoA-2", agents: ["cursor"] });
    expect(norm(clone.path)).toBe(norm(repoAClone));
  });

  test("colliding max-length basenames get distinct names instead of hanging", async () => {
    // Two folders whose sanitized basenames are identical at the 100-char name
    // cap: a dedupe suffix must reserve room within the cap, or every candidate
    // truncates back to the taken base and the loop never ends. A regression
    // here blocks the event loop, so this run dies as a timeout, not a failure.
    const longRoot = mkdtempSync(join(tmpdir(), "orc-setup-long-"));
    const stem = "x".repeat(110);
    const seeds = [
      { id: "s-long-a", dir: join(longRoot, `${stem}-aaa`), last: 60 },
      { id: "s-long-b", dir: join(longRoot, `${stem}-bbb`), last: 50 },
    ];
    try {
      const db = getSqlite();
      for (const { id, dir, last } of seeds) {
        mkdirSync(dir, { recursive: true });
        db.prepare(
          `INSERT INTO gateway_sessions
               (id, chat_id, backend, mode, runtime_session_id, cwd, execution_host, project_id, last_activity_at, created_at)
             VALUES (?, '__live-sessions__', 'claude', 'direct', ?, ?, NULL, NULL, ?, ?)`,
        ).run(id, `native-${id}`, dir, last, last);
      }

      const started = Date.now();
      const suggestions = await suggestSetupProjects();
      // Termination is the regression: bounded work returns well inside any timeout.
      expect(Date.now() - started).toBeLessThan(5000);
      const long = suggestions.filter((entry) => entry.name.startsWith("xxxx"));
      expect(long).toHaveLength(2);
      // Newest keeps the full base; the collision gets a suffix that fits the cap.
      expect(long[0]?.name).toBe(stem.slice(0, 100));
      expect(long[1]?.name).toBe(`${stem.slice(0, 98)}-2`);
      expect(long.every((entry) => /^[a-zA-Z0-9_-]{1,100}$/.test(entry.name))).toBeTrue();
      expect(new Set(long.map((entry) => entry.name.toLowerCase())).size).toBe(2);
    } finally {
      getSqlite()
        .prepare("DELETE FROM gateway_sessions WHERE id IN (?, ?)")
        .run(...seeds.map((seed) => seed.id));
      rmSync(longRoot, { recursive: true, force: true });
    }
  });

  test("GET /api/setup answers with agent rows, suggestions and the default agent", async () => {
    const res = await req(app, "GET", "/setup");
    expect(res.status).toBe(200);
    const body = await res.json<{
      agents: SetupAgentStatus[];
      suggestions: { path: string; name: string }[];
      default_agent: string | null;
    }>();
    expect(body.agents.map((row) => row.agent)).toEqual([
      "claude",
      "codex",
      "opencode",
      "pi",
      "cursor",
    ]);
    for (const row of body.agents) {
      expect(typeof row.installed).toBe("boolean");
      expect(row.signed_in === null || typeof row.signed_in === "boolean").toBeTrue();
    }
    expect(Array.isArray(body.suggestions)).toBeTrue();
    expect(body.default_agent === null || typeof body.default_agent === "string").toBeTrue();
  });

  test("the setup dismissal persists through workspace preferences", async () => {
    const before = await req(app, "GET", "/settings");
    expect((await before.json()).setup_dismissed).toBeUndefined();
    const save = await req(app, "PATCH", "/settings", { setup_dismissed: true });
    expect(save.status).toBe(200);
    expect((await save.json()).setup_dismissed).toBeTrue();
    const after = await req(app, "GET", "/settings");
    expect((await after.json()).setup_dismissed).toBeTrue();
  });
});

// --- Dismissal lifecycle ------------------------------------------------------

// Own app and database: creating or deleting a project kicks off a background
// git scan of session folders, which must not race the seeded fixture folders
// the suggestions describe removes in its teardown.
describe("setup dismissal lifecycle", () => {
  let app: ReturnType<typeof setupTestApp>;

  beforeAll(() => {
    app = setupTestApp();
  });

  afterAll(() => {
    teardownTestApp();
  });

  test("creating a project clears the setup dismissal", async () => {
    const save = await req(app, "PATCH", "/settings", { setup_dismissed: true });
    expect(save.status).toBe(200);
    const created = await req(app, "POST", "/projects", { name: "dismissal-clears" });
    expect(created.status).toBe(201);
    const project = await created.json<{ id: string }>();
    const after = await req(app, "GET", "/settings");
    expect((await after.json()).setup_dismissed).toBeUndefined();
    const removed = await req(app, "DELETE", `/projects/${project.id}`);
    expect(removed.status).toBe(204);
  });
});
