import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatThreadSchema } from "@orc/core/chat";
import { ChatStore } from "@orc/db/chat";
import { getSqlite } from "@orc/db/client";
import { z } from "zod";
import { PreviewBroker } from "../desktop-preview/broker.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

describe("targeted desktop delivery", () => {
  test("should revoke queued automation and reclaim completed queue entries", () => {
    const broker = new PreviewBroker();
    const client = crypto.randomUUID();
    const { lease } = broker.register(client, "session", undefined, true, true);
    const queued = broker.create({
      session_id: "session",
      kind: "browser",
      target: "",
      command: { action: "snapshot" },
    });
    broker.register(client, "session", lease, false);
    expect(broker.get(queued.id).status).toBe("failed");
    expect(broker.pending(client, lease)).toHaveLength(0);
    for (let count = 0; count < 40; count++) {
      const request = broker.create({
        session_id: "session",
        kind: "url",
        target: "https://example.com",
      });
      broker.acknowledge(client, lease, request.id, "opened", null);
    }
    expect(broker.list("session")).toEqual([
      { client_id: client, agent_access: false, browser_ready: false },
    ]);
    expect(() => broker.close(client, "wrong")).toThrow();
    broker.close(client, lease);
    expect(broker.list("session")).toHaveLength(0);
  });
  test("should require the correct session, desktop lease and explicit automation opt-in", () => {
    const broker = new PreviewBroker();
    const client = crypto.randomUUID();
    const registration = broker.register(client, "session");
    const request = broker.create({
      session_id: "session",
      kind: "url",
      target: "https://example.com",
    });
    expect(request.status).toBe("queued");
    expect(() => broker.pending(client, "wrong")).toThrow();
    expect(broker.pending(client, registration.lease)).toHaveLength(1);
    expect(() =>
      broker.create({ session_id: "other", kind: "url", target: "https://example.com" }),
    ).toThrow();
    expect(() =>
      broker.create({
        session_id: "session",
        kind: "browser",
        target: "",
        command: { action: "snapshot" },
      }),
    ).toThrow("Enable");
    broker.register(client, "session", registration.lease, true);
    expect(() =>
      broker.create({
        session_id: "session",
        kind: "browser",
        target: "",
        command: { action: "snapshot" },
      }),
    ).toThrow("No browser page");
    broker.register(client, "session", registration.lease, true, true);
    expect(
      broker.create({
        session_id: "session",
        kind: "browser",
        target: "",
        command: { action: "snapshot" },
      }).status,
    ).toBe("queued");
    expect(broker.acknowledge(client, registration.lease, request.id, "opened", null).status).toBe(
      "opened",
    );
    broker.register(crypto.randomUUID(), "session");
    expect(() =>
      broker.create({ session_id: "session", kind: "url", target: "https://example.com" }),
    ).toThrow("More than one");
  });
  test("should expire disconnected clients and stale requests without silently reporting success", () => {
    let now = 0;
    const broker = new PreviewBroker(() => now);
    const client = crypto.randomUUID();
    const { lease } = broker.register(client, "session");
    const request = broker.create({
      session_id: "session",
      kind: "url",
      target: "https://example.com",
    });
    now = 46_000;
    expect(() => broker.pending(client, lease)).toThrow();
    expect(broker.get(request.id)).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/disconnected/),
    });
    const live = crypto.randomUUID();
    const registration = broker.register(live, "session");
    const stale = broker.create({ session_id: "session", kind: "url", target: "https://a.test" });
    for (const at of [80_000, 120_000, 160_000, 170_000]) {
      now = at;
      broker.register(live, "session", registration.lease);
    }
    expect(broker.get(stale.id).status).toBe("expired");
  });
  test("should keep completed results after expiry and cancel queued work so it never runs late", () => {
    let now = 0;
    const broker = new PreviewBroker(() => now);
    const client = crypto.randomUUID();
    const { lease } = broker.register(client, "session", undefined, true, true);
    const browser = (): string =>
      broker.create({
        session_id: "session",
        kind: "browser",
        target: "",
        command: { action: "snapshot" },
      }).id;
    const done = browser();
    broker.acknowledge(client, lease, done, "completed", null, { ok: true });
    const waiting = browser();
    expect(broker.cancel(waiting, "stopped").status).toBe("failed");
    expect(broker.pending(client, lease).map((request) => request.id)).not.toContain(waiting);
    expect(broker.cancel(done, "stopped").status).toBe("completed");
    now = 121_000;
    expect(broker.get(done).status).toBe("completed");
  });
});

describe("desktop preview API", () => {
  let app: ReturnType<typeof setupTestApp>, directory: string, workspace: string;
  const session = crypto.randomUUID();
  beforeAll(async () => {
    app = setupTestApp();
    directory = await realpath(await mkdtemp(join(tmpdir(), "orc-preview-")));
    workspace = join(directory, "workspace");
    await mkdir(workspace);
    const initialized = Bun.spawnSync(["git", "init", "--quiet", directory], { timeout: 10000 });
    expect(initialized.exitCode).toBe(0);
    await writeFile(join(workspace, "readme.md"), "# Hello\n");
    await writeFile(join(directory, "outside.txt"), "private");
    new ChatStore(getSqlite()).save(
      ChatThreadSchema.parse({
        id: session,
        title: "Preview test",
        config: {},
        cwd: workspace,
        host: null,
        runtimeId: null,
        sourceId: null,
        backend: "codex",
        messages: [],
        updatedAt: Date.now(),
      }),
    );
  });
  afterAll(async () => {
    teardownTestApp();
    await rm(directory, { recursive: true, force: true });
  });
  test("should list all files of the session's open folder, not its git root", async () => {
    expect((await app.request(`/api/sessions/${session}/files`)).status).toBe(401);
    const response = await req(app, "GET", `/sessions/${session}/files`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      root: directory,
      path: "workspace",
      entries: [{ name: "readme.md", path: "workspace/readme.md", directory: false }],
    });
    expect((await req(app, "GET", `/sessions/${session}/files?path=../..`)).status).toBe(400);
    expect((await req(app, "GET", "/sessions/missing/files")).status).toBe(404);
  });
  test("should authenticate recording uploads, validate WebM and save only inside the resolved session workspace", async () => {
    const path = `/api/desktop-preview/recording?session_id=${session}`;
    const bytes = new Uint8Array(64);
    bytes.set([0x1a, 0x45, 0xdf, 0xa3]);
    expect(
      (
        await app.request(path, {
          method: "POST",
          body: bytes,
          headers: { "Content-Type": "video/webm" },
        })
      ).status,
    ).toBe(401);
    const headers = { Authorization: "Bearer test-secret", "Content-Type": "video/webm" };
    expect(
      (await app.request(path, { method: "POST", body: new Uint8Array(64), headers })).status,
    ).toBe(400);
    const response = await app.request(path, { method: "POST", body: bytes, headers });
    expect(response.status).toBe(200);
    const file = z.object({ path: z.string() }).parse(await response.json());
    expect(file.path.startsWith(join(workspace, ".orc", "sessions", session, "uploads"))).toBe(
      true,
    );
    expect(new Uint8Array(await readFile(file.path))).toEqual(bytes);
    const larger = new Uint8Array(3_000_000);
    larger.set([0x1a, 0x45, 0xdf, 0xa3]);
    expect((await app.request(path, { method: "POST", body: larger, headers })).status).toBe(200);
    expect(
      (
        await app.request("/api/desktop-preview/recording?session_id=missing", {
          method: "POST",
          body: bytes,
          headers,
        })
      ).status,
    ).toBe(404);
    expect(
      (await app.request(path, { method: "POST", body: new Uint8Array(16_000_001), headers }))
        .status,
    ).toBe(413);
  });
  test("should constrain browser file transfers to the session workspace and sanitize download names", async () => {
    const bytes = new Uint8Array([0, 255, 19, 42]);
    await writeFile(join(workspace, "upload.bin"), bytes);
    const upload = await req(
      app,
      "GET",
      `/desktop-preview/upload?session_id=${session}&target=upload.bin`,
    );
    expect(upload.status).toBe(200);
    expect(await upload.json()).toEqual({
      name: "upload.bin",
      data: Buffer.from(bytes).toString("base64"),
    });
    expect(
      (await req(app, "GET", `/desktop-preview/upload?session_id=${session}&target=../outside.txt`))
        .status,
    ).toBe(400);
    const path = `/api/desktop-preview/artifact?session_id=${session}&name=${encodeURIComponent("../../untrusted.bin")}`;
    expect((await app.request(path, { method: "POST", body: bytes })).status).toBe(401);
    const response = await app.request(path, {
      method: "POST",
      body: bytes,
      headers: { Authorization: "Bearer test-secret", "Content-Type": "application/octet-stream" },
    });
    expect(response.status).toBe(200);
    const file = z.object({ path: z.string() }).parse(await response.json());
    expect(file.path.startsWith(join(workspace, ".orc", "sessions", session, "uploads"))).toBe(
      true,
    );
    expect(new Uint8Array(await readFile(file.path))).toEqual(bytes);
  });
  test("should reject binary, malformed UTF-8 and oversized text while serving raster images", async () => {
    const fixtures: [string, Uint8Array, number][] = [
      ["binary.bin", new Uint8Array([0, 1, 2]), 400],
      ["invalid.txt", new Uint8Array([255, 255]), 400],
      ["large.txt", new Uint8Array(1024 * 1024 + 1).fill(65), 400],
      [
        "image.png",
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
          "base64",
        ),
        200,
      ],
    ];
    for (const [name, bytes, status] of fixtures) {
      await writeFile(join(workspace, name), bytes);
      const response = await req(
        app,
        "GET",
        `/desktop-preview/file?session_id=${session}&target=${name}`,
      );
      expect(response.status).toBe(status);
      if (status === 200)
        expect(await response.json()).toMatchObject({ kind: "image", editable: false });
    }
  });
  test("should require authentication and deny traversal, external paths and symlink escapes", async () => {
    const path = `/api/desktop-preview/file?session_id=${session}&target=readme.md`;
    expect((await app.request(path)).status).toBe(401);
    const good = await req(app, "GET", path);
    expect(good.status).toBe(200);
    expect(await good.json()).toMatchObject({ kind: "text", content: "# Hello\n", editable: true });
    for (const target of ["../outside.txt", join(directory, "outside.txt"), ".git/config"]) {
      expect(
        (
          await req(
            app,
            "GET",
            `/desktop-preview/file?session_id=${session}&target=${encodeURIComponent(target)}`,
          )
        ).status,
      ).toBe(400);
    }
    await symlink(join(directory, "outside.txt"), join(workspace, "escape.txt"));
    expect(
      (await req(app, "GET", `/desktop-preview/file?session_id=${session}&target=escape.txt`))
        .status,
    ).toBe(400);
  });
  test("should save with original-content conflict protection and preserve external edits", async () => {
    const original = "# Hello\n";
    expect(
      (
        await req(app, "PUT", "/desktop-preview/file", {
          session_id: session,
          target: "readme.md",
          content: "# Saved\n",
          original,
        })
      ).status,
    ).toBe(204);
    expect(await readFile(join(workspace, "readme.md"), "utf8")).toBe("# Saved\n");
    expect(
      (
        await req(app, "PUT", "/desktop-preview/file", {
          session_id: session,
          target: "readme.md",
          content: "lost",
          original,
        })
      ).status,
    ).toBe(409);
    expect(await readFile(join(workspace, "readme.md"), "utf8")).toBe("# Saved\n");
  });
  test("should route only to the selected desktop and report opened only after acknowledgement", async () => {
    const client = crypto.randomUUID();
    const registered = await req(app, "POST", "/desktop-preview/clients", {
      client_id: client,
      session_id: session,
    });
    const { lease } = await registered.json<{ lease: string }>();
    const queued = await req(app, "POST", "/desktop-preview/requests", {
      session_id: session,
      kind: "url",
      target: "https://example.com",
    });
    expect(queued.status).toBe(200);
    const request = await queued.json<{ id: string; status: string }>();
    expect(request.status).toBe("queued");
    expect((await req(app, "GET", `/desktop-preview/clients/${client}/requests`)).status).toBe(401);
    expect(
      (
        await req(
          app,
          "POST",
          `/desktop-preview/requests/${request.id}/ack`,
          { client_id: client, status: "opened" },
          { "X-Preview-Lease": lease },
        )
      ).status,
    ).toBe(200);
    expect(
      await (await req(app, "GET", `/desktop-preview/requests/${request.id}`)).json(),
    ).toMatchObject({ status: "opened" });
    expect(
      (
        await req(app, "POST", "/desktop-preview/browser", {
          session_id: session,
          command: { action: "snapshot" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await req(app, "POST", "/desktop-preview/requests", {
          session_id: session,
          kind: "url",
          target: "file:///private",
        })
      ).status,
    ).toBe(400);
  });
});
