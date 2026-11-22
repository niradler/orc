import { afterAll, describe, expect, test } from "bun:test";
import { requestGracefulStop } from "./daemon.js";

const servers: Array<{ stop: () => void }> = [];
afterAll(() => {
  for (const server of servers) server.stop();
});

function stub(status: number) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(JSON.stringify({ instance_id: "test" }), { status }),
  });
  servers.push(server);
  return { host: "127.0.0.1", port: server.port as number, secret: undefined };
}

describe("daemon graceful stop", () => {
  test("reports success once the daemon accepted the drain and exited", async () => {
    const target = stub(202);
    // First probe: still there, then gone — the loop must keep polling, not give up.
    const probes: number[] = [];
    const gone = await requestGracefulStop(4242, 5, target, () => {
      probes.push(Date.now());
      return probes.length === 1; // alive on the first probe, gone after
    });
    expect(gone).toBe(true);
    expect(probes.length).toBe(2);
  });

  test("gives up when the daemon stays alive past the timeout", async () => {
    const target = stub(202);
    const gone = await requestGracefulStop(4242, 1, target, () => true);
    expect(gone).toBe(false);
  });

  test("reports failure when the API refuses the request", async () => {
    const target = stub(500);
    // A refused drain is not a stop: the caller decides how to fall back.
    expect(await requestGracefulStop(4242, 2, target, () => false)).toBe(false);
  });

  test("treats an unreachable API as already stopped when the pid is gone", async () => {
    // Nothing listens on this port; a real shutdown may have closed it first.
    const gone = await requestGracefulStop(
      4242,
      1,
      { host: "127.0.0.1", port: 9, secret: "secret" },
      () => false,
    );
    expect(gone).toBe(true);
  });
});
