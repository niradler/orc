import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfig } from "@orc/core/config";
import { hostRuntime } from "@orc/core/exec-host";
import {
  MAX_HANDOFF_BYTES,
  type SessionBundle,
  type SessionHandoffInput,
  SessionHandoffSchema,
} from "@orc/core/session-handoff";
import { getDb } from "@orc/db/client";
import { gateway_sessions, projects, session_handoffs } from "@orc/db/schema";
import { executeTool } from "@orc/mcp/tools";
import { eq } from "drizzle-orm";
import { handoffAdapters } from "../handoffs/adapters.js";
import { repositoryIdentity } from "../handoffs/git.js";
import { HandoffService, setHandoffService } from "../handoffs/service.js";
import type { createApp } from "../server.js";
import { TerminalManager } from "../terminals/manager.js";
import { setTerminalManager } from "../terminals/service.js";
import type { PtyHandle, SpawnOptions } from "../terminals/spawn.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

const root = mkdtempSync(join(tmpdir(), "orc-handoff-"));
const remote = join(root, "remote.git");
const source = join(root, "source");
const target = join(root, "target");
const agentHome = join(root, "home");
const sourceId = "12345678-1234-4234-8234-123456789abc";
const originalApiBase = process.env.ORC_API_BASE;
let app: ReturnType<typeof createApp>;
let commit: string;
let service: HandoffService;
let manager: TerminalManager;
const launches: { argv: string[]; cwd: string | undefined }[] = [];

async function git(...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(stderr);
  return stdout.trim();
}

function input(
  agent: "claude" | "codex" = "claude",
  over: Partial<SessionHandoffInput> = {},
): SessionHandoffInput {
  return {
    project: "handoff-fixture",
    agent,
    session_id: sourceId,
    source_cwd: source,
    repository: remote,
    remote: "origin",
    branch: "handoff/test",
    commit,
    ...over,
  };
}

function bundle(agent: "claude" | "codex" = "claude"): SessionBundle {
  const rows =
    agent === "claude"
      ? [
          {
            type: "user",
            sessionId: sourceId,
            cwd: source,
            gitBranch: "handoff/test",
            message: { role: "user", content: `Keep historical path ${source}` },
          },
          {
            type: "assistant",
            sessionId: sourceId,
            cwd: source,
            message: { role: "assistant", content: [{ type: "text", text: "Continue this work" }] },
          },
        ]
      : [
          {
            timestamp: new Date().toISOString(),
            type: "session_meta",
            payload: {
              id: sourceId,
              cwd: source,
              timestamp: new Date().toISOString(),
              source: "cli",
              cli_version: "0.100.0",
              model_provider: "openai",
            },
          },
          {
            type: "turn_context",
            payload: {
              cwd: source,
              sandbox_policy: { type: "workspace-write", writable_roots: [source] },
            },
          },
          {
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: `Keep historical path ${source}` }],
            },
          },
        ];
  return {
    version: 1,
    files: [
      { path: "session.jsonl", content: `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` },
    ],
  };
}

async function create(
  agent: "claude" | "codex" = "claude",
  over: Partial<SessionHandoffInput> = {},
) {
  const response = await req(app, "POST", "/session-handoffs", input(agent, over));
  expect(response.status).toBe(201);
  return response.json();
}

async function upload(url: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function handoffResponse(response: Response) {
  return SessionHandoffSchema.parse(await response.json());
}

class FakePty implements PtyHandle {
  pid = 1234;
  private finish!: (code: number | null) => void;
  exited = new Promise<number | null>((resolve) => {
    this.finish = resolve;
  });
  write(): void {}
  resize(): void {}
  kill(): void {
    this.finish(0);
  }
}

beforeAll(async () => {
  await git("init", "--bare", remote);
  await git("init", source);
  writeFileSync(join(source, ".gitignore"), "# Worktree exclusions are installed by ORC\n");
  writeFileSync(join(source, ".gitattributes"), "* -text\n");
  writeFileSync(join(source, "work.txt"), "the pushed state\n");
  mkdirSync(join(source, "packages", "app"), { recursive: true });
  writeFileSync(join(source, "packages", "app", "marker.txt"), "subdirectory state\n");
  await git(
    "-C",
    source,
    "add",
    ".gitignore",
    ".gitattributes",
    "work.txt",
    "packages/app/marker.txt",
  );
  await git(
    "-C",
    source,
    "-c",
    "user.name=ORC Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "Initial state",
  );
  commit = await git("-C", source, "rev-parse", "HEAD");
  await git("-C", source, "remote", "add", "origin", remote);
  await git("-C", source, "push", "origin", "HEAD:refs/heads/handoff/test");
  await git("clone", "--branch", "handoff/test", remote, target);
  mkdirSync(agentHome);
  app = setupTestApp();
  process.env.ORC_TERMINALS_ENABLED = "1";
  resetConfig();
  await getDb()
    .insert(projects)
    .values({ id: "handoff-project", name: "handoff-fixture", scope: target });
  service = new HandoffService({
    storageRoot: join(root, "uploads"),
    runtimeFor: (host) => ({
      ...hostRuntime(host),
      home: async () => agentHome,
      binary: async () => "agent",
    }),
  });
  setHandoffService(service);
  manager = new TerminalManager({
    spawn: (argv: string[], options: SpawnOptions) => {
      launches.push({ argv, cwd: options.cwd });
      return new FakePty();
    },
    env: process.env,
    max: 8,
    scrollbackBytes: 1024,
  });
  setTerminalManager(manager);
});

afterAll(() => {
  manager.shutdown();
  setTerminalManager(null);
  setHandoffService(null);
  if (originalApiBase === undefined) delete process.env.ORC_API_BASE;
  else process.env.ORC_API_BASE = originalApiBase;
  delete process.env.ORC_TERMINALS_ENABLED;
  teardownTestApp();
});

describe("native session handoff", () => {
  test("should require auth for creation, inspection and preparation, and an upload token for PUT", async () => {
    expect((await app.request("/api/session-handoffs", { method: "POST" })).status).toBe(401);
    const handoff = await create();
    expect((await app.request(`/api/session-handoffs/${handoff.id}`)).status).toBe(401);
    expect(
      (await app.request(`/api/session-handoffs/${handoff.id}/prepare`, { method: "POST" })).status,
    ).toBe(401);
    expect(
      (await upload(handoff.upload_url.replace(/token=.*/, `token=${"a".repeat(43)}`), bundle()))
        .status,
    ).toBe(401);
    const inspected = await req(app, "GET", `/session-handoffs/${handoff.id}`);
    const data = await inspected.json();
    expect(data.upload_url).toBeUndefined();
    expect(data.token_hash).toBeUndefined();
    expect(data.status).toBe("pending");
  });

  test("should import Claude and sidecars into a new session and a pinned nested worktree", async () => {
    const handoff = await create();
    const body = bundle();
    body.files.push({
      path: "subagents/agent-example.jsonl",
      content: `${JSON.stringify({
        type: "assistant",
        sessionId: sourceId,
        cwd: source,
        message: { content: "Subagent history" },
      })}\n`,
    });
    const uploaded = await upload(handoff.upload_url, body);
    expect(uploaded.status).toBe(200);
    const ready = await handoffResponse(uploaded);
    expect(ready.status).toBe("ready");
    expect(ready.session_id).not.toBe(sourceId);
    const cwd = ready.cwd as string;
    expect(cwd.replace(/\\/g, "/")).toBe(
      `${target.replace(/\\/g, "/")}/.orc/worktrees/${handoff.id}`,
    );
    expect(await git("-C", cwd, "rev-parse", "HEAD")).toBe(commit);
    expect(await git("-C", cwd, "symbolic-ref", "--short", "HEAD")).toBe(
      `orc/handoff/${handoff.id}`,
    );
    expect(await git("-C", cwd, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe(
      "origin/handoff/test",
    );
    expect(readFileSync(join(cwd, "work.txt"), "utf8")).toBe("the pushed state\n");
    expect(await git("-C", target, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
    const live = await getDb().query.gateway_sessions.findFirst({
      where: eq(gateway_sessions.id, ready.live_session_id as string),
    });
    expect(live?.project_id).toBe("handoff-project");
    expect(live?.status).toBe("stopped");
    const text = readFileSync(live?.transcript_path as string, "utf8");
    expect(text).toContain(ready.session_id);
    expect(JSON.parse(text.split("\n")[0] as string).cwd).toBe(ready.cwd);
    expect(text).toContain(`Keep historical path ${source}`.replace(/\\/g, "\\\\"));
    const listing = await (await req(app, "GET", "/sessions/live")).json();
    expect(
      listing.sessions.find((row: { id: string }) => row.id === ready.live_session_id)?.handoff
        .status,
    ).toBe("ready");
    expect((await upload(handoff.upload_url, body)).status).toBe(401);
    const retried = await (
      await req(app, "POST", `/session-handoffs/${handoff.id}/prepare`)
    ).json();
    expect(retried.live_session_id).toBe(ready.live_session_id);
  });

  test("should relocate Codex metadata, then use the existing terminal resume API once", async () => {
    const handoff = await create("codex");
    const ready = await handoffResponse(await upload(handoff.upload_url, bundle("codex")));
    expect(ready.status).toBe("ready");
    const live = await getDb().query.gateway_sessions.findFirst({
      where: eq(gateway_sessions.id, ready.live_session_id as string),
    });
    const rows = readFileSync(live?.transcript_path as string, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows[0].payload.id).toBe(ready.session_id);
    expect(rows[0].payload.cwd).toBe(ready.cwd);
    expect(rows[1].payload.sandbox_policy.writable_roots).toEqual([ready.cwd]);
    const started = await req(app, "POST", "/terminals", {
      live_session_id: ready.live_session_id,
    });
    expect(started.status).toBe(201);
    const terminal = await started.json();
    expect(terminal.cwd).toBe(ready.cwd);
    expect(launches.at(-1)?.argv.slice(1)).toEqual([
      "resume",
      ready.session_id,
      "--cd",
      ready.cwd as string,
    ]);
    const again = await req(app, "POST", "/terminals", { live_session_id: ready.live_session_id });
    expect(again.status).toBe(200);
    expect((await again.json()).id).toBe(terminal.id);
    expect((await service.get(handoff.id)).status).toBe("resumed");
  });

  test("should refuse to launch an imported checkout that changed before its first resume", async () => {
    const handoff = await create();
    const ready = await handoffResponse(await upload(handoff.upload_url, bundle()));
    writeFileSync(join(ready.cwd as string, "work.txt"), "unsaved work\n");
    const before = launches.length;
    const result = await req(app, "POST", "/terminals", { live_session_id: ready.live_session_id });
    expect(result.status).toBe(409);
    expect(launches.length).toBe(before);
    expect((await service.get(handoff.id)).status).toBe("ready");
    expect(readFileSync(join(ready.cwd as string, "work.txt"), "utf8")).toBe("unsaved work\n");
  });

  test("should reject traversal, mixed IDs, unsupported agents, bad repositories and invalid Git refs", async () => {
    const handoff = await create();
    const bad = bundle();
    bad.files.push({ path: "../../auth.json", content: "{}" });
    expect((await upload(handoff.upload_url, bad)).status).toBe(400);
    const mixed = bundle();
    const main = mixed.files[0];
    if (!main) throw new Error("Fixture is missing its main transcript");
    main.content += `${JSON.stringify({ type: "user", sessionId: "another" })}\n`;
    expect((await upload(handoff.upload_url, mixed)).status).toBe(400);
    expect((await service.get(handoff.id)).status).toBe("pending");
    for (const over of [
      { agent: "gemini" },
      { branch: "--upload-pack=evil" },
      { branch: "@{-1}" },
      { commit: "bad" },
      { repository: "https://example.invalid/other.git" },
      { project: "unknown" },
    ]) {
      const result = await req(app, "POST", "/session-handoffs", { ...input(), ...over });
      expect([400, 404]).toContain(result.status);
    }
    expect(() => repositoryIdentity("https://user:secret@example.com/repo")).toThrow();
    expect(repositoryIdentity("git@github.com:owner/repo.git")).toBe(
      repositoryIdentity("https://github.com/owner/repo.git"),
    );
  });

  test("should expire upload links and bind capabilities to one handoff", async () => {
    const first = await create();
    const second = await create();
    const stolen = new URL(second.upload_url);
    stolen.search = new URL(first.upload_url).search;
    expect((await upload(stolen.toString(), bundle())).status).toBe(401);
    await getDb()
      .update(session_handoffs)
      .set({ expires_at: new Date(Date.now() - 1) })
      .where(eq(session_handoffs.id, first.id));
    expect((await upload(first.upload_url, bundle())).status).toBe(401);
  });

  test("should bound uploads before parsing and leave the capability usable after rejection", async () => {
    const handoff = await create();
    expect(
      (
        await upload(handoff.upload_url, bundle(), {
          "Content-Length": String(MAX_HANDOFF_BYTES + 1),
        })
      ).status,
    ).toBe(400);
    expect(
      (await upload(handoff.upload_url, bundle(), { "Content-Type": "text/plain" })).status,
    ).toBe(400);
    expect((await service.get(handoff.id)).status).toBe("pending");
    const waiting = await req(app, "POST", `/session-handoffs/${handoff.id}/prepare`);
    expect(waiting.status).toBe(409);
    expect((await service.get(handoff.id)).status).toBe("pending");
  });

  test("should retain a failed upload and prepare it after the missing pushed branch becomes available", async () => {
    const handoff = await create("claude", { branch: "handoff/later" });
    const failed = await handoffResponse(await upload(handoff.upload_url, bundle()));
    expect(failed.status).toBe("error");
    expect(failed.live_session_id).toBeNull();
    await git("-C", source, "push", "origin", `${commit}:refs/heads/handoff/later`);
    const retried = await req(app, "POST", `/session-handoffs/${handoff.id}/prepare`);
    expect(retried.status).toBe(200);
    expect((await retried.json()).status).toBe("ready");
  });

  test("should reject a remote branch that does not point at the reported SHA", async () => {
    const handoff = await create("claude", { commit: "a".repeat(40) });
    const result = await handoffResponse(await upload(handoff.upload_url, bundle()));
    expect(result.status).toBe("error");
    expect(result.error).toContain("differs from the reported commit");
    expect(result.cwd).toBeNull();
  });

  test("should expose one MCP tool that requests the same HTTP upload contract", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    process.env.ORC_API_BASE = `http://127.0.0.1:${server.port}`;
    try {
      const output = JSON.parse(await executeTool("session_handoff", input()));
      expect(output.status).toBe("pending");
      expect(output.upload_url).toContain(`/api/session-handoffs/${output.id}/upload?token=`);
      expect(output.upload_url).toStartWith(process.env.ORC_API_BASE as string);
      const forwarded = await app.request("https://orc.example/api/mcp/tool", {
        method: "POST",
        headers: { Authorization: "Bearer test-secret", "Content-Type": "application/json" },
        body: JSON.stringify({ name: "session_handoff", args: input() }),
      });
      expect(forwarded.status).toBe(200);
      const result = (await forwarded.json()) as { result: string };
      expect(JSON.parse(result.result).upload_url).toStartWith(
        "https://orc.example/api/session-handoffs/",
      );
      const probe = Bun.spawn(
        [
          process.execPath,
          "-e",
          `import { executeTool } from '@orc/mcp/tools'; const result = JSON.parse(await executeTool('session_handoff', ${JSON.stringify(input())})); if (result.status !== 'pending') throw new Error('Unexpected status'); console.log('API_ONLY_OK');`,
        ],
        {
          env: { ...process.env, ORC_DB_PATH: join(source, "work.txt") },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 30_000,
        },
      );
      const [probeOutput, probeError, probeCode] = await Promise.all([
        new Response(probe.stdout).text(),
        new Response(probe.stderr).text(),
        probe.exited,
      ]);
      expect(probeError).toBe("");
      expect(probeCode).toBe(0);
      expect(probeOutput).toContain("API_ONLY_OK");
      expect(readFileSync(join(source, "work.txt"), "utf8")).toBe("the pushed state\n");
    } finally {
      server.stop(true);
    }
  });

  test("should construct POSIX native destinations for an SSH host without copying message paths", () => {
    const request = { ...input("codex"), remote: "origin", subdirectory: "" };
    const files = handoffAdapters.codex.installFiles(
      bundle("codex"),
      request,
      sourceId,
      "/repo/.orc/worktrees/id",
      "/home/agent",
      new Date("2026-10-13T10:00:00Z"),
    );
    expect(files[0]?.path).toBe(
      `/home/agent/.codex/sessions/2026/10/13/rollout-2026-10-13T10-00-00-${sourceId}.jsonl`,
    );
    expect(files[0]?.content).toContain("/repo/.orc/worktrees/id");
  });

  test("should resume from the reported repository subdirectory", async () => {
    const handoff = await create("codex", {
      subdirectory: "packages/app",
      source_cwd: join(source, "packages", "app"),
    });
    const ready = await handoffResponse(await upload(handoff.upload_url, bundle("codex")));
    expect(ready.status).toBe("ready");
    expect(ready.cwd?.replace(/\\/g, "/")).toEndWith(`/.orc/worktrees/${handoff.id}/packages/app`);
    expect(readFileSync(join(ready.cwd as string, "marker.txt"), "utf8")).toBe(
      "subdirectory state\n",
    );
    expect(
      (await req(app, "POST", "/session-handoffs", input("codex", { subdirectory: "../escape" })))
        .status,
    ).toBe(400);
  });

  test("should bound the actual streamed upload even when its content-length claims it is small", async () => {
    const handoff = await create();
    let count = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++count <= 65) controller.enqueue(new Uint8Array(1024 * 1024));
        else controller.close();
      },
    });
    const result = await app.request(handoff.upload_url, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Content-Length": "1" },
      body: stream,
    });
    expect(result.status).toBe(400);
    expect((await service.get(handoff.id)).status).toBe("pending");
  });

  test("should refuse child-agent Codex imports and retain the pending capability", async () => {
    const handoff = await create("codex");
    const body = bundle("codex");
    const file = body.files[0];
    if (!file) throw new Error("Missing fixture");
    const rows = file.content
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    rows[0].payload.parent_thread_id = sourceId;
    file.content = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    const result = await upload(handoff.upload_url, body);
    expect(result.status).toBe(400);
    expect(((await result.json()) as { error: string }).error).toContain("parent Codex session");
    expect((await service.get(handoff.id)).status).toBe("pending");
  });

  test("should preserve an existing native file instead of overwriting it", async () => {
    const handoff = await create();
    const row = await service.get(handoff.id);
    const cwd = join(target, ".orc", "worktrees", row.id);
    const destination = handoffAdapters.claude.installFiles(
      bundle(),
      row.request,
      row.session_id,
      cwd,
      agentHome,
      row.created_at,
    )[0]?.path;
    if (!destination) throw new Error("Missing native path");
    mkdirSync(join(destination, ".."), { recursive: true });
    writeFileSync(destination, "existing native data");
    const failed = await handoffResponse(await upload(handoff.upload_url, bundle()));
    expect(failed.status).toBe("error");
    expect(readFileSync(destination, "utf8")).toBe("existing native data");
  });

  test("should launch one terminal when simultaneous requests resume the same handoff", async () => {
    const handoff = await create("codex");
    const ready = await handoffResponse(await upload(handoff.upload_url, bundle("codex")));
    const before = launches.length;
    const results = await Promise.all([
      req(app, "POST", "/terminals", { live_session_id: ready.live_session_id }),
      req(app, "POST", "/terminals", { live_session_id: ready.live_session_id }),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(launches.length - before).toBe(1);
    const terminals = await Promise.all(results.map((response) => response.json()));
    expect(terminals[0].id).toBe(terminals[1].id);
  });

  test("should recover stale preparation without stealing an active lease", async () => {
    const handoff = await create("claude", { branch: "handoff/lease" });
    const failed = await handoffResponse(await upload(handoff.upload_url, bundle()));
    expect(failed.status).toBe("error");
    await git("-C", source, "push", "origin", `${commit}:refs/heads/handoff/lease`);
    await getDb()
      .update(session_handoffs)
      .set({ status: "preparing", error: null, updated_at: new Date() })
      .where(eq(session_handoffs.id, handoff.id));
    expect((await req(app, "POST", `/session-handoffs/${handoff.id}/prepare`)).status).toBe(409);
    expect((await service.get(handoff.id)).status).toBe("preparing");
    await getDb()
      .update(session_handoffs)
      .set({ updated_at: new Date(Date.now() - 6 * 60 * 1000) })
      .where(eq(session_handoffs.id, handoff.id));
    const recovered = await req(app, "POST", `/session-handoffs/${handoff.id}/prepare`);
    expect(recovered.status).toBe(200);
    expect((await recovered.json()).status).toBe("ready");
  });

  test("should keep an imported session resumable as unassigned after its project is deleted", async () => {
    await getDb()
      .insert(projects)
      .values({ id: "handoff-deleted-project", name: "handoff-deleted-project", scope: target });
    const handoff = await create("claude", { project: "handoff-deleted-project" });
    const ready = await handoffResponse(await upload(handoff.upload_url, bundle()));
    expect(ready.status).toBe("ready");
    expect((await req(app, "DELETE", "/projects/handoff-deleted-project")).status).toBe(204);
    const retained = await service.get(handoff.id);
    expect(retained.project_id).toBeNull();
    expect(retained.live_session_id).toBe(ready.live_session_id);
    expect(await service.verifyResume(ready.live_session_id as string)).toBe(true);
  });
});
