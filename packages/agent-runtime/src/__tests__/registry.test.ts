import { describe, expect, it } from "bun:test";
import { createBackend, listRegisteredBackends } from "../index.js";

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
});
