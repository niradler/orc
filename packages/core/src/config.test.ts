import { describe, expect, test } from "bun:test";
import { OrcConfigSchema } from "./config.js";

describe("agent_loop defaults", () => {
  test("a config with no agent_loop key does not start autonomous workers", () => {
    const cfg = OrcConfigSchema.parse({});
    expect(cfg.agent_loop.enabled).toBe(false);
  });

  test("a config with a partial agent_loop key does not start them either", () => {
    const cfg = OrcConfigSchema.parse({ agent_loop: { max_workers: 3 } });
    expect(cfg.agent_loop.enabled).toBe(false);
    expect(cfg.agent_loop.max_workers).toBe(3);
  });

  test("opting in is explicit", () => {
    const cfg = OrcConfigSchema.parse({ agent_loop: { enabled: true } });
    expect(cfg.agent_loop.enabled).toBe(true);
    expect(cfg.agent_loop.poll_interval_minutes).toBe(5);
  });
});
