import { describe, expect, it } from "bun:test";
import { createBackend, listRegisteredBackends } from "../index.js";

describe("backend registry", () => {
  it("lists registered backends", () => {
    const backends = listRegisteredBackends();
    expect(backends).toContain("claude");
    expect(backends).toContain("acpx");
    expect(backends).toContain("a2a");
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

  it("throws for unregistered backend", () => {
    expect(() => createBackend("nonexistent" as any)).toThrow(/No agent backend registered/);
  });
});
