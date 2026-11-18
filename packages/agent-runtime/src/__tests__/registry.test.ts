import { describe, expect, it } from "bun:test";
import { AcpSession } from "../acp.js";
import { ClaudeSession } from "../claude.js";
import { CodexAppSession } from "../codex-app.js";
import { createBackend, listRegisteredBackends } from "../index.js";
import type { AgentSession } from "../types.js";

describe("backend registry", () => {
  it("lists registered backends", () => {
    const backends = listRegisteredBackends();
    expect(backends).toContain("claude");
    expect(backends).toContain("acpx");
    expect(backends).toContain("a2a");
    // Previously imported by nobody, so unreachable: registered under explicit
    // names now, which keeps `codex` meaning "acpx driving codex".
    expect(backends).toContain("claude-cli");
    expect(backends).toContain("codex-cli");
    expect(backends).toContain("cursor");
    expect(backends).toContain("opencode");
  });

  it("creates a claude backend", () => {
    const backend = createBackend("claude");
    expect(backend).toBeDefined();
    expect(backend.name).toBe("claude");
    expect(typeof backend.startSession).toBe("function");
    expect(typeof backend.preflight).toBe("function");
  });

  it("creates an acpx backend", () => {
    const backend = createBackend("acpx");
    expect(backend).toBeDefined();
    expect(backend.name).toBe("acpx");
  });

  it("creates an a2a backend", () => {
    const backend = createBackend("a2a");
    expect(backend).toBeDefined();
    expect(backend.name).toBe("a2a");
  });

  it("creates the claude CLI backend under its own name", () => {
    const backend = createBackend("claude-cli");
    expect(backend.name).toBe("claude-cli");
  });

  // Behaviour change: this used to return acpx. Silently substituting acpx made
  // a typo'd backend look like it worked while running acpx's *default* agent,
  // and turned a missing acpx into a spawn error from a backend nobody picked.
  // Unknown-name-means-acpx-agent still happens, in resolveBackend().
  it("throws for an unregistered backend instead of substituting acpx", () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing invalid input
    expect(() => createBackend("nonexistent" as any)).toThrow(/No agent backend registered/);
  });

  it("names the registered backends in the error, so the fix is obvious", () => {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: testing invalid input
      createBackend("nonexistent" as any);
      throw new Error("expected createBackend to throw");
    } catch (err) {
      expect((err as Error).message).toContain("acpx");
      expect((err as Error).message).toContain("claude");
    }
  });

  it("advertises only controls whose session methods exist", () => {
    const host = { kind: "local" } as const;
    const sessions: Record<string, AgentSession> = {
      "claude-cli": new ClaudeSession({ cwd: "/" }, "claude", host),
      "codex-cli": new CodexAppSession({ cwd: "/" }, host),
      opencode: new AcpSession({ cwd: "/" }, ["opencode", "acp"]),
    };
    for (const [name, session] of Object.entries(sessions)) {
      const backend = createBackend(name as "claude-cli" | "codex-cli" | "opencode");
      const implemented = {
        interrupt: typeof session.interrupt === "function",
        steering: typeof session.steer === "function",
        livePermissions: typeof session.setPermissionMode === "function",
        questions: typeof session.respondQuestion === "function",
        fork: typeof backend.forkSession === "function",
      };
      for (const [key, has] of Object.entries(implemented))
        if (backend.capabilities?.[key as keyof typeof implemented])
          expect(`${name}.${key}:${has}`).toBe(`${name}.${key}:true`);
    }
    expect(createBackend("claude-cli").capabilities).toMatchObject({
      interrupt: false,
      steering: false,
      livePermissions: false,
      questions: false,
      approvals: false,
      images: false,
    });
  });
});
