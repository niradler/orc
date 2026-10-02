import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { OrcConfigSchema, resetConfig } from "@orc/core/config";
import { getDb } from "@orc/db/client";
import { bridge_chats, gateway_sessions } from "@orc/db/schema";
import type { createApp } from "../server.js";
import { LIVE_CHAT_ID } from "../session-watcher.js";
import { TerminalManager } from "../terminals/manager.js";
import {
  getTerminalManager,
  setTerminalManager,
  terminalsAvailability,
} from "../terminals/service.js";
import type { PtyHandle, SpawnOptions } from "../terminals/spawn.js";
import {
  handleTerminalUpgrade,
  parseControl,
  type TerminalSocketData,
  terminalSocketTarget,
  terminalWebsocket,
} from "../terminals/ws.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

class FakePty implements PtyHandle {
  pid = 7;
  written: string[] = [];
  sizes: [number, number][] = [];
  killed = 0;
  private finish!: (code: number | null) => void;
  exited = new Promise<number | null>((resolve) => {
    this.finish = resolve;
  });

  constructor(
    readonly argv: string[],
    readonly options: SpawnOptions,
  ) {}

  write(data: string | Uint8Array) {
    this.written.push(typeof data === "string" ? data : new TextDecoder().decode(data));
  }
  resize(cols: number, rows: number) {
    this.sizes.push([cols, rows]);
  }
  kill() {
    this.killed++;
    this.finish(137);
  }
  emit(text: string) {
    this.options.onData(new TextEncoder().encode(text));
  }
}

const ptys: FakePty[] = [];
const root = realpathSync(mkdtempSync(join(tmpdir(), "orc-terminals-")));
const binDir = join(root, "bin");
const originalPath = process.env.PATH;
let app: ReturnType<typeof createApp>;

function installFakeBinary(name: string) {
  const file = join(binDir, process.platform === "win32" ? `${name}.cmd` : name);
  writeFileSync(file, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\nexit 0\n");
  if (process.platform !== "win32") chmodSync(file, 0o755);
}

async function seedLive(
  id: string,
  over: Partial<typeof gateway_sessions.$inferInsert> = {},
): Promise<void> {
  await getDb()
    .insert(gateway_sessions)
    .values({
      id,
      chat_id: LIVE_CHAT_ID,
      backend: "claude",
      mode: "live",
      runtime_session_id: `sess-${id}`,
      cwd: root,
      title: `title ${id}`,
      ...over,
    });
}

beforeAll(async () => {
  process.env.ORC_TERMINALS_ENABLED = "1";
  resetConfig();
  app = setupTestApp();
  resetConfig();
  require("node:fs").mkdirSync(binDir, { recursive: true });
  installFakeBinary("claude");
  installFakeBinary("codex");
  process.env.PATH = `${binDir}${delimiter}${originalPath}`;
  await getDb()
    .insert(bridge_chats)
    .values({ id: LIVE_CHAT_ID, platform: "telegram", chat_id: "live" })
    .onConflictDoNothing();
  setTerminalManager(
    new TerminalManager({
      spawn: (argv, options) => {
        const pty = new FakePty(argv, options);
        ptys.push(pty);
        return pty;
      },
      env: { PATH: "/bin" },
      max: 8,
      scrollbackBytes: 4096,
    }),
  );
});

afterAll(() => {
  getTerminalManager().shutdown();
  setTerminalManager(null);
  process.env.PATH = originalPath;
  delete process.env.ORC_TERMINALS_ENABLED;
  teardownTestApp();
  resetConfig();
  rmSync(root, { recursive: true, force: true });
});

describe("availability", () => {
  test("on by default, but refuses to run without an api secret", () => {
    expect(OrcConfigSchema.parse({}).terminals.enabled).toBe(true);
    const noSecret = terminalsAvailability(OrcConfigSchema.parse({}));
    expect(noSecret.ready).toBe(false);
    expect(noSecret.reason).toContain("api.secret");
    const ok = terminalsAvailability(OrcConfigSchema.parse({ api: { secret: "s" } }));
    expect(ok).toEqual({ ready: true, reason: null });
  });

  test("allow_without_secret opts in on loopback only", () => {
    const optIn = { terminals: { allow_without_secret: true } };
    expect(terminalsAvailability(OrcConfigSchema.parse(optIn))).toEqual({
      ready: true,
      reason: null,
    });
    const exposed = terminalsAvailability(
      OrcConfigSchema.parse({ ...optIn, api: { host: "0.0.0.0" } }),
    );
    expect(exposed.ready).toBe(false);
    expect(exposed.reason).toContain("loopback");
    expect(OrcConfigSchema.parse({}).terminals.allow_without_secret).toBe(false);
  });

  test("can be switched off", () => {
    const off = terminalsAvailability(
      OrcConfigSchema.parse({ terminals: { enabled: false }, api: { secret: "s" } }),
    );
    expect(off.ready).toBe(false);
    expect(off.reason).toContain("disabled");
  });

  test("needs a Bun that can attach a PTY", () => {
    const config = OrcConfigSchema.parse({ api: { secret: "s" } });
    expect(terminalsAvailability(config, "1.2.21")).toMatchObject({ ready: false });
    expect(terminalsAvailability(config, "1.2.21").reason).toContain("1.4.2");
    expect(terminalsAvailability(config, "1.4.2").ready).toBe(true);
    expect(terminalsAvailability(config, "1.5.0").ready).toBe(true);
  });

  test("the HTTP routes need the bearer secret like every other route", async () => {
    const res = await app.request("/api/terminals");
    expect(res.status).toBe(401);
  });
});

describe("POST /terminals", () => {
  test("starts a plain shell in a directory", async () => {
    const res = await req(app, "POST", "/terminals", { kind: "shell", cwd: root });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ kind: "shell", cwd: root, status: "running" });
    await req(app, "DELETE", `/terminals/${body.id}`);
  });

  test("rejects a cwd that is not a directory", async () => {
    const res = await req(app, "POST", "/terminals", { kind: "shell", cwd: join(root, "nope") });
    expect(res.status).toBe(400);
  });

  test("rejects an unknown kind", async () => {
    const res = await req(app, "POST", "/terminals", { kind: "rm -rf" });
    expect(res.status).toBe(400);
  });

  test("an unknown live session is 404 and nothing is spawned", async () => {
    const before = ptys.length;
    const res = await req(app, "POST", "/terminals", { live_session_id: "does-not-exist" });
    expect(res.status).toBe(404);
    expect(ptys.length).toBe(before);
  });

  test("an agent with no resume command is rejected", async () => {
    await seedLive("live-cursor", { backend: "cursor" });
    const before = ptys.length;
    const res = await req(app, "POST", "/terminals", { live_session_id: "live-cursor" });
    expect(res.status).toBe(400);
    expect(ptys.length).toBe(before);
  });

  test("a live session without an agent session id is rejected", async () => {
    await seedLive("live-noid", { runtime_session_id: null });
    const res = await req(app, "POST", "/terminals", { live_session_id: "live-noid" });
    expect(res.status).toBe(400);
  });

  test("a malformed agent session id never reaches spawn", async () => {
    await seedLive("live-bad", { runtime_session_id: "x; rm -rf /" });
    const before = ptys.length;
    const res = await req(app, "POST", "/terminals", { live_session_id: "live-bad" });
    expect(res.status).toBe(400);
    expect(ptys.length).toBe(before);
  });

  test("resumes claude with server-built argv and the session cwd, and reattaches on repeat", async () => {
    await seedLive("live-ok");
    const first = await req(app, "POST", "/terminals", { live_session_id: "live-ok" });
    expect(first.status).toBe(201);
    const info = await first.json();
    const pty = ptys.at(-1);
    expect(pty?.argv.slice(1)).toEqual(["--resume", "sess-live-ok"]);
    expect(pty?.argv[0]).toContain("claude");
    expect(pty?.options.cwd).toBe(root);
    expect(info.live_session_id).toBe("live-ok");

    const spawned = ptys.length;
    const again = await req(app, "POST", "/terminals", { live_session_id: "live-ok" });
    expect(again.status).toBe(200);
    expect((await again.json()).id).toBe(info.id);
    expect(ptys.length).toBe(spawned);
    await req(app, "DELETE", `/terminals/${info.id}`);
  });

  test("resumes codex with the resume subcommand", async () => {
    await seedLive("live-codex", { backend: "codex" });
    const res = await req(app, "POST", "/terminals", { live_session_id: "live-codex" });
    expect(res.status).toBe(201);
    expect(ptys.at(-1)?.argv.slice(1)).toEqual(["resume", "sess-live-codex"]);
    await req(app, "DELETE", `/terminals/${(await res.json()).id}`);
  });
});

describe("GET /terminals and tickets", () => {
  test("lists launchers and running terminals", async () => {
    const created = await (await req(app, "POST", "/terminals", { kind: "shell" })).json();
    const body = await (await req(app, "GET", "/terminals")).json();
    expect(body).toMatchObject({ enabled: true, ready: true, reason: null });
    expect(body.launchers).toContain("shell");
    expect(body.terminals.map((t: { id: string }) => t.id)).toContain(created.id);
    await req(app, "DELETE", `/terminals/${created.id}`);
  });

  test("a ticket is minted per terminal and unknown terminals are 404", async () => {
    const created = await (await req(app, "POST", "/terminals", { kind: "shell" })).json();
    const res = await req(app, "POST", `/terminals/${created.id}/ticket`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ticket.length).toBeGreaterThanOrEqual(32);
    expect(body.expires_in).toBeGreaterThan(0);
    expect((await req(app, "POST", "/terminals/nope/ticket")).status).toBe(404);
    await req(app, "DELETE", `/terminals/${created.id}`);
  });

  test("delete kills the process", async () => {
    const created = await (await req(app, "POST", "/terminals", { kind: "shell" })).json();
    const pty = ptys.at(-1);
    expect((await req(app, "DELETE", `/terminals/${created.id}`)).status).toBe(204);
    expect(pty?.killed).toBe(1);
    expect((await req(app, "GET", `/terminals/${created.id}`)).status).toBe(404);
  });
});

describe("control frame parsing", () => {
  test("only an exact resize or stop object is a control frame", () => {
    expect(parseControl('{"type":"resize","cols":100,"rows":30}')).toEqual({
      type: "resize",
      cols: 100,
      rows: 30,
    });
    expect(parseControl('{"type":"stop"}')).toEqual({ type: "stop" });
  });

  test.each([
    "ls -la",
    "{",
    "null",
    '{"type":"resize","cols":"100","rows":30}',
    '{"type":"resize","cols":1,"rows":30}',
    '{"type":"resize","cols":100,"rows":9999}',
    '{"type":"resize","cols":100.5,"rows":30}',
    '{"type":"resize","cols":100,"rows":30,"x":1}',
    '{"type":"stop","force":true}',
    '{"type":"other"}',
  ])("is not a control frame: %s", (text) => {
    expect(parseControl(text)).toBeNull();
  });

  test("socket path accepts the prefixed and proxied forms only", () => {
    expect(terminalSocketTarget("/api/terminals/abc/ws")).toBe("abc");
    expect(terminalSocketTarget("/terminals/abc/ws")).toBe("abc");
    expect(terminalSocketTarget("/api/terminals/abc/ticket")).toBeNull();
    expect(terminalSocketTarget("/api/terminals/a/b/ws")).toBeNull();
  });
});

describe("terminal WebSocket", () => {
  let server: ReturnType<typeof Bun.serve<TerminalSocketData>>;

  beforeAll(() => {
    server = Bun.serve<TerminalSocketData>({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request, srv) {
        const handled = handleTerminalUpgrade(request, srv);
        return handled === null ? new Response("not found", { status: 404 }) : handled;
      },
      websocket: terminalWebsocket,
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  function connect(id: string, ticket: string) {
    const ws = new WebSocket(
      `ws://127.0.0.1:${server.port}/api/terminals/${id}/ws?ticket=${ticket}`,
    );
    ws.binaryType = "arraybuffer";
    const binary: string[] = [];
    const text: string[] = [];
    ws.onmessage = (e) => {
      if (typeof e.data === "string") text.push(e.data);
      else binary.push(new TextDecoder().decode(e.data as ArrayBuffer));
    };
    const opened = new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
    });
    const closed = new Promise<void>((resolve) => {
      ws.onclose = () => resolve();
    });
    return { ws, binary, text, opened, closed };
  }

  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(check()).toBe(true);
  };

  test("rejects a missing, wrong, reused or cross-terminal ticket", async () => {
    const manager = getTerminalManager();
    const a = manager.create({
      launch: { kind: "shell", argv: ["sh"], cwd: undefined, resume: false },
    });
    const b = manager.create({
      launch: { kind: "shell", argv: ["sh"], cwd: undefined, resume: false },
    });
    expect(await connect(a.id, "").opened).toBe(false);
    expect(await connect(a.id, "bogus").opened).toBe(false);
    const forB = manager.mintTicket(b.id).ticket;
    expect(await connect(a.id, forB).opened).toBe(false);
    const once = manager.mintTicket(a.id).ticket;
    const first = connect(a.id, once);
    expect(await first.opened).toBe(true);
    first.ws.close();
    expect(await connect(a.id, once).opened).toBe(false);
    manager.remove(a.id);
    manager.remove(b.id);
  });

  test("input, resize, detach-without-kill, reattach with scrollback, then stop", async () => {
    const manager = getTerminalManager();
    const info = manager.create({
      launch: { kind: "shell", argv: ["sh"], cwd: undefined, resume: false },
    });
    const pty = ptys.at(-1) as FakePty;

    const one = connect(info.id, manager.mintTicket(info.id).ticket);
    expect(await one.opened).toBe(true);
    pty.emit("prompt> ");
    await until(() => one.binary.join("") === "prompt> ");

    // Keystrokes are binary frames; text frames are control messages only.
    one.ws.send(new TextEncoder().encode("ls\r"));
    one.ws.send('{"type":"resize","cols":90,"rows":25}');
    await until(() => pty.written.length === 1 && pty.sizes.length === 1);
    expect(pty.written).toEqual(["ls\r"]);
    expect(pty.sizes).toEqual([[90, 25]]);

    // Typed text that looks like JSON is input when binary, and never a control message.
    const lookalike = '{"type":"stop"}';
    one.ws.send(new TextEncoder().encode(lookalike));
    await until(() => pty.written.length === 2);
    expect(pty.written[1]).toBe(lookalike);
    expect(pty.killed).toBe(0);

    // A text frame that is not a control message is dropped, not written to the shell.
    one.ws.send("ls -la\r");
    one.ws.send('{"type":"resize","cols":"wide","rows":25}');
    await new Promise((r) => setTimeout(r, 50));
    expect(pty.written).toHaveLength(2);
    expect(pty.sizes).toEqual([[90, 25]]);

    one.ws.close();
    await one.closed;
    await new Promise((r) => setTimeout(r, 30));
    expect(pty.killed).toBe(0);
    expect(manager.get(info.id).status).toBe("running");

    pty.emit("while away");
    const two = connect(info.id, manager.mintTicket(info.id).ticket);
    expect(await two.opened).toBe(true);
    await until(() => two.binary.join("") === "prompt> while away");
    // The scrollback is marked as history, so the client can mute terminal replies to it.
    await until(() => two.text.length > 0);
    expect(JSON.parse(two.text[0] as string)).toEqual({ type: "replay-end" });

    two.ws.send('{"type":"stop"}');
    await until(() => two.text.length > 1);
    expect(JSON.parse(two.text[1] as string)).toEqual({ type: "exit", code: 137 });
    expect(pty.killed).toBe(1);
    expect(manager.get(info.id).status).toBe("exited");
    two.ws.close();
    manager.remove(info.id);
  });

  test("removing a terminal closes its sockets", async () => {
    const manager = getTerminalManager();
    const info = manager.create({
      launch: { kind: "shell", argv: ["sh"], cwd: undefined, resume: false },
    });
    const one = connect(info.id, manager.mintTicket(info.id).ticket);
    expect(await one.opened).toBe(true);
    manager.remove(info.id);
    await Promise.race([
      one.closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("socket stayed open")), 2000)),
    ]);
  });
});
