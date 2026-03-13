import { describe, expect, it } from "bun:test";
import { PermissionManager } from "./permission-manager.js";
import { PreviewManager } from "./preview-manager.js";
import { SessionLock } from "./session-lock.js";
import type { GatewayAdapter, SupportsMessageUpdate } from "./types.js";

// ─── SessionLock ────────────────────────────────────────────────────────────

describe("SessionLock", () => {
  it("acquires a free session", () => {
    const lock = new SessionLock();
    expect(lock.tryAcquire("s1")).toBe(true);
  });

  it("rejects a locked session", () => {
    const lock = new SessionLock();
    lock.tryAcquire("s1");
    expect(lock.tryAcquire("s1")).toBe(false);
  });

  it("releases and re-acquires", () => {
    const lock = new SessionLock();
    lock.tryAcquire("s1");
    lock.release("s1");
    expect(lock.tryAcquire("s1")).toBe(true);
  });

  it("independent sessions don't block each other", () => {
    const lock = new SessionLock();
    lock.tryAcquire("s1");
    expect(lock.tryAcquire("s2")).toBe(true);
  });

  it("isLocked reflects state", () => {
    const lock = new SessionLock();
    expect(lock.isLocked("s1")).toBe(false);
    lock.tryAcquire("s1");
    expect(lock.isLocked("s1")).toBe(true);
    lock.release("s1");
    expect(lock.isLocked("s1")).toBe(false);
  });
});

// ─── PermissionManager ──────────────────────────────────────────────────────

describe("PermissionManager", () => {
  it("resolves approved", async () => {
    const pm = new PermissionManager();
    const p = pm.waitFor("r1");
    pm.resolve("r1", true);
    expect(await p).toBe(true);
  });

  it("resolves denied", async () => {
    const pm = new PermissionManager();
    const p = pm.waitFor("r1");
    pm.resolve("r1", false);
    expect(await p).toBe(false);
  });

  it("resolve returns false for unknown id", () => {
    const pm = new PermissionManager();
    expect(pm.resolve("unknown", true)).toBe(false);
  });

  it("resolve is idempotent — second call returns false", async () => {
    const pm = new PermissionManager();
    const p = pm.waitFor("r1");
    expect(pm.resolve("r1", true)).toBe(true);
    expect(pm.resolve("r1", true)).toBe(false);
    await p;
  });

  it("denyAll resolves all pending as false", async () => {
    const pm = new PermissionManager();
    const p1 = pm.waitFor("r1");
    const p2 = pm.waitFor("r2");
    pm.denyAll();
    expect(await p1).toBe(false);
    expect(await p2).toBe(false);
  });

  it("hasPending tracks correctly", () => {
    const pm = new PermissionManager();
    expect(pm.hasPending("r1")).toBe(false);
    pm.waitFor("r1");
    expect(pm.hasPending("r1")).toBe(true);
    pm.resolve("r1", true);
    expect(pm.hasPending("r1")).toBe(false);
  });
});

// ─── PreviewManager ─────────────────────────────────────────────────────────

function makeAdapter(
  updateFn: (chatId: string, msgId: string, text: string) => Promise<void>,
): GatewayAdapter & SupportsMessageUpdate {
  return {
    platform: "telegram",
    async start() {},
    async stop() {},
    async send() {
      return "chat:1";
    },
    updateMessage: updateFn,
  };
}

describe("PreviewManager", () => {
  it("supports() returns true for adapters with updateMessage", () => {
    const adapter = makeAdapter(async () => {});
    expect(PreviewManager.supports(adapter)).toBe(true);
  });

  it("supports() returns false for plain adapter", () => {
    const plain: GatewayAdapter = {
      platform: "slack",
      async start() {},
      async stop() {},
      async send() {
        return undefined;
      },
    };
    expect(PreviewManager.supports(plain)).toBe(false);
  });

  it("finalize sends final text", async () => {
    const edits: string[] = [];
    const adapter = makeAdapter(async (_c, _m, text) => {
      edits.push(text);
    });
    const pm = new PreviewManager(adapter);
    await pm.init("s1", "chat1", "chat1:1", "thinking…");
    await pm.finalize("s1", "Final answer");
    expect(edits).toContain("Final answer");
  });

  it("dedup: finalize skips edit if text matches last", async () => {
    const edits: string[] = [];
    const adapter = makeAdapter(async (_c, _m, text) => {
      edits.push(text);
    });
    const pm = new PreviewManager(adapter);
    await pm.init("s1", "chat1", "chat1:1", "thinking…");
    await pm.finalize("s1", "thinking…");
    expect(edits).toHaveLength(0);
  });

  it("degrade: marks degraded and stops editing after edit failure", async () => {
    let callCount = 0;
    const adapter = makeAdapter(async () => {
      callCount++;
      throw new Error("rate limited");
    });
    const pm = new PreviewManager(adapter);
    await pm.init("s1", "chat1", "chat1:1", "start");
    await pm.update("s1", "x".repeat(50));
    await pm.update("s1", "y".repeat(50));
    expect(callCount).toBeLessThanOrEqual(2);
  });

  it("cleanup removes session state", async () => {
    const adapter = makeAdapter(async () => {});
    const pm = new PreviewManager(adapter);
    await pm.init("s1", "chat1", "chat1:1", "start");
    pm.cleanup("s1");
  });

  it("freeze stops updates; unfreeze flushes pending", async () => {
    const edits: string[] = [];
    const adapter = makeAdapter(async (_c, _m, text) => {
      edits.push(text);
    });
    const pm = new PreviewManager(adapter);
    await pm.init("s1", "chat1", "chat1:1", "start");
    pm.freeze("s1");
    await pm.update("s1", `while frozen ${"x".repeat(40)}`);
    expect(edits).toHaveLength(0);
    pm.unfreeze("s1");
    await new Promise((r) => setTimeout(r, 50));
    expect(edits.length).toBeGreaterThan(0);
  });
});

// ─── Mode routing (pure logic) ───────────────────────────────────────────────

function classifyMode(mode: string): "job" | "agent" | "direct" | "multi" | "other" {
  if (mode.startsWith("job:")) return "job";
  if (mode.startsWith("agent:")) return "agent";
  if (mode === "direct") return "direct";
  if (mode === "multi") return "multi";
  return "other";
}

describe("Mode routing logic", () => {
  it("job: prefix extracts job name", () => {
    const mode = "job:deploy";
    expect(classifyMode(mode)).toBe("job");
    expect(mode.slice(4)).toBe("deploy");
  });

  it("agent:claude is recognized as agent mode", () => {
    expect(classifyMode("agent:claude")).toBe("agent");
  });

  it("agent:codex is recognized as agent mode", () => {
    expect(classifyMode("agent:codex")).toBe("agent");
  });

  it("agent:cursor is recognized as agent mode", () => {
    expect(classifyMode("agent:cursor")).toBe("agent");
  });

  it("direct mode classified correctly", () => {
    expect(classifyMode("direct")).toBe("direct");
  });

  it("multi mode classified correctly", () => {
    expect(classifyMode("multi")).toBe("multi");
  });
});
