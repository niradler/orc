import { describe, expect, test } from "bun:test";
import type { Launch } from "../terminals/launch.js";
import { TerminalManager, type TerminalSink } from "../terminals/manager.js";
import type { PtyHandle, SpawnOptions } from "../terminals/spawn.js";

class FakePty implements PtyHandle {
  pid = 4242;
  written: (string | Uint8Array)[] = [];
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
    this.written.push(data);
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
  exit(code: number | null) {
    this.finish(code);
  }
}

function setup(
  over: {
    max?: number;
    scrollbackBytes?: number;
    now?: () => number;
    answerDeviceAttributes?: boolean;
  } = {},
) {
  const ptys: FakePty[] = [];
  const manager = new TerminalManager({
    spawn: (argv, options) => {
      const pty = new FakePty(argv, options);
      ptys.push(pty);
      return pty;
    },
    env: { PATH: "/bin", HOME: undefined },
    max: over.max ?? 8,
    scrollbackBytes: over.scrollbackBytes ?? 1024,
    now: over.now,
    answerDeviceAttributes: over.answerDeviceAttributes,
  });
  return { manager, ptys };
}

const launch = (over: Partial<Launch> = {}): Launch => ({
  kind: "shell",
  argv: ["/bin/sh"],
  cwd: "/work/app",
  resume: false,
  ...over,
});

function sink() {
  const out: string[] = [];
  const exits: (number | null)[] = [];
  const events: string[] = [];
  const s: TerminalSink = {
    output: (d) => {
      const text = new TextDecoder().decode(d);
      out.push(text);
      events.push(`output:${text}`);
    },
    exit: (c) => {
      exits.push(c);
      events.push("exit");
    },
    replayed: () => events.push("replayed"),
    close: () => events.push("close"),
  };
  return { s, out, exits, events };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("TerminalManager", () => {
  test("spawns with a PTY env and the launch cwd", () => {
    const { manager, ptys } = setup();
    const info = manager.create({ launch: launch() });
    expect(info.status).toBe("running");
    expect(info.pid).toBe(4242);
    expect(info.cwd).toBe("/work/app");
    expect(ptys[0]?.options.env).toEqual({
      PATH: "/bin",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      TERM_PROGRAM: "orc",
    });
    expect(ptys[0]?.options.cwd).toBe("/work/app");
  });

  test("answers device-attribute and colour queries a shell prints", () => {
    const { manager, ptys } = setup({ answerDeviceAttributes: true });
    const { id } = manager.create({ launch: launch() });
    manager.attach(id, sink().s);
    ptys[0]?.emit("\x1b[c\x1b]11;?\x07");
    expect(ptys[0]?.written).toEqual(["\x1b[?62;22c", "\x1b]11;rgb:0909/0e0e/1a1a\x07"]);
  });

  test("leaves device attributes to the PTY layer when told to", () => {
    const { manager, ptys } = setup();
    manager.create({ launch: launch() });
    ptys[0]?.emit("\x1b[c\x1b[>0q");
    expect(ptys[0]?.written).toEqual(["\x1bP>|orc\x1b\\"]);
  });

  test("does not answer queries replayed from scrollback", () => {
    const { manager, ptys } = setup({ answerDeviceAttributes: true });
    const { id } = manager.create({ launch: launch() });
    ptys[0]?.emit("\x1b[c");
    ptys[0]?.written.splice(0);
    manager.attach(id, sink().s);
    expect(ptys[0]?.written).toEqual([]);
  });

  test("detaching a socket does not kill the process", () => {
    const { manager, ptys } = setup();
    const { id } = manager.create({ launch: launch() });
    const detach = manager.attach(id, sink().s);
    detach();
    expect(ptys[0]?.killed).toBe(0);
    expect(manager.get(id).status).toBe("running");
  });

  test("stop kills the process and keeps the entry as exited", async () => {
    const { manager, ptys } = setup();
    const { id } = manager.create({ launch: launch() });
    const { s, exits } = sink();
    manager.attach(id, s);
    manager.stop(id);
    await tick();
    expect(ptys[0]?.killed).toBe(1);
    expect(manager.get(id)).toMatchObject({ status: "exited", exit_code: 137 });
    expect(exits).toEqual([137]);
  });

  test("remove kills a running process and forgets it", () => {
    const { manager, ptys } = setup();
    const { id } = manager.create({ launch: launch() });
    manager.remove(id);
    expect(ptys[0]?.killed).toBe(1);
    expect(() => manager.get(id)).toThrow(/not found/);
  });

  test("reattach replays scrollback then streams live output", () => {
    const { manager, ptys } = setup();
    const { id } = manager.create({ launch: launch() });
    ptys[0]?.emit("hello ");
    const first = sink();
    const detach = manager.attach(id, first.s);
    ptys[0]?.emit("world");
    detach();
    ptys[0]?.emit("!");
    const second = sink();
    manager.attach(id, second.s);
    expect(first.out).toEqual(["hello ", "world"]);
    expect(second.out.join("")).toBe("hello world!");
  });

  test("marks the end of the replay before live output and before a replayed exit", async () => {
    const { manager, ptys } = setup();
    const { id } = manager.create({ launch: launch() });
    ptys[0]?.emit("old");
    const live = sink();
    manager.attach(id, live.s);
    ptys[0]?.emit("new");
    expect(live.events).toEqual(["output:old", "replayed", "output:new"]);

    ptys[0]?.exit(0);
    await tick();
    const late = sink();
    manager.attach(id, late.s);
    expect(late.events).toEqual(["output:old", "output:new", "replayed", "exit"]);
  });

  test("remove and shutdown close attached sinks, and detached ones are left alone", () => {
    const { manager } = setup();
    const a = manager.create({ launch: launch() });
    const b = manager.create({ launch: launch() });
    const attached = sink();
    const detached = sink();
    manager.attach(a.id, attached.s);
    manager.attach(a.id, detached.s)();
    manager.remove(a.id);
    expect(attached.events).toContain("close");
    expect(detached.events).not.toContain("close");

    const other = sink();
    manager.attach(b.id, other.s);
    manager.shutdown();
    expect(other.events).toContain("close");
  });

  test("scrollback is capped but never empty", () => {
    const { manager, ptys } = setup({ scrollbackBytes: 10 });
    const { id } = manager.create({ launch: launch() });
    for (const word of ["aaaaaa", "bbbbbb", "cccccc"]) ptys[0]?.emit(word);
    const late = sink();
    manager.attach(id, late.s);
    expect(late.out).toEqual(["cccccc"]);
  });

  test("a process that exited on its own is replayed with its exit code", async () => {
    const { manager, ptys } = setup();
    const { id } = manager.create({ launch: launch() });
    ptys[0]?.emit("bye");
    ptys[0]?.exit(0);
    await tick();
    const late = sink();
    manager.attach(id, late.s);
    expect(late.out).toEqual(["bye"]);
    expect(late.exits).toEqual([0]);
  });

  test("input and resize reach only a running pty", async () => {
    const { manager, ptys } = setup();
    const { id } = manager.create({ launch: launch() });
    manager.write(id, "ls\r");
    manager.resize(id, 100, 40);
    expect(ptys[0]?.written).toEqual(["ls\r"]);
    expect(ptys[0]?.sizes).toEqual([[100, 40]]);
    ptys[0]?.exit(0);
    await tick();
    manager.write(id, "ignored");
    expect(ptys[0]?.written).toHaveLength(1);
  });

  test("the running limit is enforced, exited terminals do not count", async () => {
    const { manager, ptys } = setup({ max: 2 });
    manager.create({ launch: launch() });
    manager.create({ launch: launch() });
    expect(() => manager.create({ launch: launch() })).toThrow(/limit/);
    ptys[0]?.exit(0);
    await tick();
    expect(() => manager.create({ launch: launch() })).not.toThrow();
  });

  test("finds a running terminal by live session only", async () => {
    const { manager, ptys } = setup();
    const { id } = manager.create({ launch: launch(), liveSessionId: "live-1" });
    expect(manager.findByLiveSession("live-1")?.id).toBe(id);
    expect(manager.findByLiveSession("live-2")).toBeNull();
    ptys[0]?.exit(0);
    await tick();
    expect(manager.findByLiveSession("live-1")).toBeNull();
  });

  test("names default to kind and directory", () => {
    const { manager } = setup();
    expect(manager.create({ launch: launch({ kind: "claude", resume: true }) }).name).toBe(
      "claude (resume) · app",
    );
    expect(manager.create({ launch: launch({ cwd: undefined }) }).name).toBe("shell");
  });

  test("should link a fresh terminal by agent PID while rejecting stale or mismatched records", async () => {
    const { manager, ptys } = setup({ now: () => 1000 });
    const terminal = manager.create({ launch: launch({ kind: "claude" }) });
    const input = {
      id: "live-new",
      pid: terminal.pid,
      backend: "claude",
      createdAt: new Date(1001),
    };
    expect(manager.linkLiveSession({ ...input, pid: null })).toBeNull();
    expect(manager.linkLiveSession({ ...input, pid: 99 })).toBeNull();
    expect(manager.linkLiveSession({ ...input, backend: "codex" })).toBeNull();
    expect(manager.linkLiveSession({ ...input, createdAt: new Date(999) })).toBeNull();
    expect(manager.linkLiveSession(input)?.id).toBe(terminal.id);
    expect(manager.findByLiveSession(input.id)?.id).toBe(terminal.id);
    ptys[0]?.exit(0);
    await tick();
    expect(manager.linkLiveSession(input)).toBeNull();
  });

  test("shutdown kills everything", () => {
    const { manager, ptys } = setup();
    manager.create({ launch: launch() });
    manager.create({ launch: launch() });
    manager.shutdown();
    expect(ptys.map((p) => p.killed)).toEqual([1, 1]);
    expect(manager.list()).toEqual([]);
  });
});

describe("tickets", () => {
  test("a ticket works once, for its own terminal", () => {
    const { manager } = setup();
    const a = manager.create({ launch: launch() });
    const b = manager.create({ launch: launch() });
    const { ticket } = manager.mintTicket(a.id);
    expect(manager.redeemTicket(ticket, b.id)).toBe(false);
    const again = manager.mintTicket(a.id).ticket;
    expect(manager.redeemTicket(again, a.id)).toBe(true);
    expect(manager.redeemTicket(again, a.id)).toBe(false);
  });

  test("tickets expire", () => {
    let now = 1_000_000;
    const { manager } = setup({ now: () => now });
    const { id } = manager.create({ launch: launch() });
    const { ticket, expires_in } = manager.mintTicket(id);
    now += (expires_in + 1) * 1000;
    expect(manager.redeemTicket(ticket, id)).toBe(false);
  });

  test("tickets are unguessable and unique", () => {
    const { manager } = setup();
    const { id } = manager.create({ launch: launch() });
    const tickets = new Set(Array.from({ length: 50 }, () => manager.mintTicket(id).ticket));
    expect(tickets.size).toBe(50);
    for (const t of tickets) expect(t.length).toBeGreaterThanOrEqual(32);
  });

  test("minting for an unknown terminal fails", () => {
    expect(() => setup().manager.mintTicket("nope")).toThrow(/not found/);
  });
});
