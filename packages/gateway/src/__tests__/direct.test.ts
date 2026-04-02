import { describe, expect, it } from "bun:test";
import type { GatewayMode } from "@orc/core/types";
import { backendFromMode } from "../direct.js";

describe("backendFromMode", () => {
  it("returns backend name for agent: prefix", () => {
    expect(backendFromMode("agent:claude")).toBe("claude");
    expect(backendFromMode("agent:acpx")).toBe("acpx");
    expect(backendFromMode("agent:a2a")).toBe("a2a");
    expect(backendFromMode("agent:gemini")).toBe("gemini");
  });

  it("returns claude for non-agent modes", () => {
    expect(backendFromMode("direct")).toBe("claude");
    expect(backendFromMode("multi")).toBe("claude");
  });

  it("returns claude for job: modes (not a backend)", () => {
    // job: modes are valid GatewayMode but should not extract a backend
    expect(backendFromMode("job:build" as GatewayMode)).toBe("claude");
    expect(backendFromMode("job:deploy" as GatewayMode)).toBe("claude");
  });

  it("returns claude for bare agent: with no suffix", () => {
    expect(backendFromMode("agent:" as GatewayMode)).toBe("claude");
  });
});
