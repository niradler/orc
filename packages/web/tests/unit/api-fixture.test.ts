import { expect, test } from "bun:test";
import { reserveLoopbackPort, withRunningApis } from "../../scripts/api-fixture.js";

test("should keep all shard ports reserved until their API starts", async () => {
  const ports: Awaited<ReturnType<typeof reserveLoopbackPort>>[] = [];
  try {
    for (let index = 0; index < 4; index++) ports.push(await reserveLoopbackPort());
    expect(new Set(ports.map((entry) => entry.port)).size).toBe(4);
    for (const entry of ports)
      await expect(reserveLoopbackPort(entry.port)).rejects.toMatchObject({ code: "EADDRINUSE" });
    const first = ports[0];
    if (!first) throw new Error("Missing first reservation");
    await first.release();
    await first.release();
    const replacement = await reserveLoopbackPort(first.port);
    await replacement.release();
  } finally {
    await Promise.all(ports.map((entry) => entry.release()));
  }
});

test("should reject a dead owned API even when another server is healthy", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("healthy"),
  });
  const child = Bun.spawn([process.execPath, "-e", "process.exit(17)"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  let operationSignal: AbortSignal | undefined;
  try {
    await expect(
      withRunningApis([child], async (signal) => {
        operationSignal = signal;
        expect((await fetch(server.url)).ok).toBe(true);
        await child.exited;
        await Bun.sleep(100);
      }),
    ).rejects.toThrow("API exited unexpectedly with code 17");
    expect(operationSignal?.aborted).toBe(true);
  } finally {
    server.stop(true);
    await child.exited;
  }
});
