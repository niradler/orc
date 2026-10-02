import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDaemon, isHealthy } from "./daemon.js";

const dir = mkdtempSync(join(tmpdir(), "orc-desktop-"));
const servers: { stop: () => void }[] = [];

afterAll(() => {
  for (const s of servers) s.stop();
});

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port as number;
  probe.stop(true);
  return port;
}

function fakeBin(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env bun\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("ensureDaemon", () => {
  test("attaches to a healthy daemon without spawning", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ status: "ok" }),
    });
    servers.push(server);
    const daemon = await ensureDaemon({
      port: server.port as number,
      bin: join(dir, "does-not-exist"),
    });
    expect(daemon.owned).toBe(false);
    expect(daemon.url).toBe(`http://127.0.0.1:${server.port}`);
  });

  test.skipIf(process.platform === "win32")("spawns the binary with --port when nothing is listening, and stop() kills it", async () => {
    const port = freePort();
    const bin = fakeBin(
      "serve",
      `Bun.serve({ port: Number(process.argv[3]), fetch: () => Response.json({ status: "ok", secret: process.env.ORC_API_SECRET ?? null }) });
await new Promise(() => {});`,
    );
    const daemon = await ensureDaemon({ port, bin, secret: "s3cret", timeoutMs: 10_000 });
    expect(daemon.owned).toBe(true);
    const body = (await (await fetch(`${daemon.url}/api/health`)).json()) as { secret: string };
    expect(body.secret).toBe("s3cret");
    expect(await isHealthy(daemon.url)).toBe(true);
    daemon.stop();
    for (let i = 0; i < 20 && (await isHealthy(daemon.url)); i++) await Bun.sleep(100);
    expect(await isHealthy(daemon.url)).toBe(false);
  });

  test.skipIf(process.platform === "win32")("throws when the binary exits before becoming healthy", async () => {
    const bin = fakeBin("exits", "process.exit(3);");
    await expect(ensureDaemon({ port: freePort(), bin, timeoutMs: 10_000 })).rejects.toThrow(
      "exited with code 3",
    );
  });

  test("throws when the binary is missing", async () => {
    await expect(
      ensureDaemon({ port: freePort(), bin: join(dir, "missing"), timeoutMs: 1000 }),
    ).rejects.toThrow("orc binary not found");
  });
});
