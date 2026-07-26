import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAcpxCli } from "../acpx.js";
import { listRegisteredBackends, probeBackend, probeBackends } from "../index.js";

const ORIGINAL_ACPX_PATH = process.env.ORC_ACPX_PATH;

afterEach(() => {
  if (ORIGINAL_ACPX_PATH === undefined) delete process.env.ORC_ACPX_PATH;
  else process.env.ORC_ACPX_PATH = ORIGINAL_ACPX_PATH;
});

describe("resolveAcpxCli", () => {
  it("honours an explicit ORC_ACPX_PATH over PATH lookup", () => {
    const dir = join(tmpdir(), `orc-acpx-probe-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const fake = join(dir, "acpx");
    writeFileSync(fake, "#!/bin/sh\necho 9.9.9\n");
    try {
      process.env.ORC_ACPX_PATH = fake;
      const resolved = resolveAcpxCli();
      expect(resolved?.source).toBe("config");
      expect(resolved?.path).toBe(fake.replaceAll("\\", "/"));
      // A bare binary is spawned directly.
      expect(resolved?.cmd).toEqual([fake.replaceAll("\\", "/")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs a .js entry point through an interpreter rather than spawning it", () => {
    const dir = join(tmpdir(), `orc-acpx-js-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const cli = join(dir, "cli.js");
    writeFileSync(cli, "console.log('9.9.9');\n");
    try {
      process.env.ORC_ACPX_PATH = cli;
      const resolved = resolveAcpxCli();
      expect(resolved?.cmd).toHaveLength(2);
      expect(resolved?.cmd[1]).toBe(cli.replaceAll("\\", "/"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a stale ORC_ACPX_PATH instead of resolving to something missing", () => {
    process.env.ORC_ACPX_PATH = join(tmpdir(), "definitely-not-here", "acpx");
    const resolved = resolveAcpxCli();
    // Falls through to PATH or the bundled copy; never returns the missing path.
    expect(resolved?.source).not.toBe("config");
    expect(resolved?.path).not.toContain("definitely-not-here");
  });
});

describe("probeBackends", () => {
  it("reports one entry per registered backend", async () => {
    const probes = await probeBackends();
    expect(probes.map((p) => p.name).sort()).toEqual([...listRegisteredBackends()].sort());
  });

  it("classifies how each backend reaches its agent", async () => {
    const probes = await probeBackends();
    const byName = new Map(probes.map((p) => [p.name, p]));
    // The point of the split: `claude` needs no external binary spawned by us,
    // acpx does, and agentapi is a service.
    expect(byName.get("claude")?.kind).toBe("in-process");
    expect(byName.get("acpx")?.kind).toBe("cli");
    expect(byName.get("agentapi")?.kind).toBe("http");
  });

  it("says what a backend requires even when it is unavailable", async () => {
    const probe = await probeBackend("acpx");
    expect(probe.requires).toContain("acpx");
    // Unavailable must come with a reason, or the UI has nothing to show.
    if (!probe.available) expect(probe.error).toBeTruthy();
  });

  it("does not throw for an unregistered backend, it reports it", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing invalid input
    const probe = await probeBackend("nope" as any);
    expect(probe.available).toBe(false);
    expect(probe.error).toContain("No agent backend registered");
  });
});
