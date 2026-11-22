import { afterAll, describe, expect, test } from "bun:test";
import { requestGracefulStop, stopDaemon } from "./daemon.js";

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

describe("daemon graceful drain over HTTP", () => {
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

describe("stopDaemon on every platform", () => {
  test("drains over HTTP on Windows, macOS and Linux alike", async () => {
    for (const target of ["win32", "darwin", "linux"] as const) {
      const signals: string[] = [];
      const outcome = await stopDaemon(4242, {
        timeoutSeconds: 1,
        platform: target,
        gracefulStop: async () => true,
        signal: (_pid, signal) => {
          signals.push(signal);
          return true;
        },
        alive: () => true,
      });
      expect(outcome).toEqual({ stopped: true, how: "drain" });
      expect(signals).toEqual([]);
    }
  });

  test("Windows cannot fall back to a signal when the drain is refused", async () => {
    const signals: string[] = [];
    const outcome = await stopDaemon(4242, {
      timeoutSeconds: 1,
      platform: "win32",
      gracefulStop: async () => false,
      signal: (_pid, signal) => {
        signals.push(signal);
        return true;
      },
      alive: () => true,
    });
    expect(outcome).toEqual({ stopped: false });
    expect(signals).toEqual([]);
  });

  for (const target of ["darwin", "linux"] as const) {
    test(`falls back to SIGTERM on ${target} and waits for the exit`, async () => {
      const signals: string[] = [];
      let probes = 0;
      const outcome = await stopDaemon(4242, {
        timeoutSeconds: 5,
        platform: target,
        gracefulStop: async () => false,
        signal: (_pid, signal) => {
          signals.push(signal);
          return true;
        },
        alive: () => ++probes === 1, // alive on the first probe, gone after
      });
      expect(outcome).toEqual({ stopped: true, how: "signal" });
      expect(signals).toEqual(["SIGTERM"]);
      expect(probes).toBe(2);
    });
  }

  test("reports a still-running daemon when SIGTERM does not take", async () => {
    const outcome = await stopDaemon(4242, {
      timeoutSeconds: 1,
      platform: "darwin",
      gracefulStop: async () => false,
      signal: () => true,
      alive: () => true,
    });
    expect(outcome).toEqual({ stopped: false });
  });

  test("--force kills without asking the API, then waits for the port", async () => {
    let gracefulCalls = 0;
    let probes = 0;
    const outcome = await stopDaemon(4242, {
      timeoutSeconds: 5,
      force: true,
      gracefulStop: async () => {
        gracefulCalls++;
        return true;
      },
      signal: (_pid, signal) => signal === "SIGKILL",
      alive: () => ++probes === 1,
    });
    expect(outcome).toEqual({ stopped: true, how: "kill" });
    expect(gracefulCalls).toBe(0);
  });

  test("reports a still-running daemon when the force kill does not take", async () => {
    const outcome = await stopDaemon(4242, {
      timeoutSeconds: 1,
      force: true,
      signal: () => true,
      alive: () => true,
    });
    expect(outcome).toEqual({ stopped: false });
  });

  test("treats a failed signal to an already-gone pid as stopped", async () => {
    const outcome = await stopDaemon(4242, {
      timeoutSeconds: 1,
      force: true,
      signal: () => false,
      alive: () => false,
    });
    expect(outcome).toEqual({ stopped: true, how: "kill" });
  });

  // The fallback above is only graceful if the platform really delivers SIGTERM
  // to the daemon's handler; prove it against a real process on macOS and Linux.
  test.skipIf(process.platform === "win32")(
    "SIGTERM reaches a POSIX daemon's handler and the stop waits for the exit",
    async () => {
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          'process.on("SIGTERM", () => { console.log("drained"); process.exit(0); }); setTimeout(() => {}, 10000);',
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
      );
      try {
        await Bun.sleep(300);
        // An unreachable API is exactly the case the CLI falls back from.
        const outcome = await stopDaemon(child.pid, {
          timeoutSeconds: 5,
          gracefulStop: async () => false,
        });
        expect(outcome).toEqual({ stopped: true, how: "signal" });
        expect(await child.exited).toBe(0);
        expect(await new Response(child.stdout).text()).toContain("drained");
      } finally {
        child.kill();
      }
    },
  );
});
