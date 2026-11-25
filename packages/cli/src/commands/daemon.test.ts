import { describe, expect, test } from "bun:test";
import { closeSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchdPlist, openDaemonLogFd, volatileBinPath } from "./daemon.js";

describe("daemon install binary path guard", () => {
  test("rejects the fnm per-shell path from the bug report", () => {
    expect(
      volatileBinPath("/Users/nir/.local/state/fnm_multishells/8188_1788532082554/bin/orc"),
    ).toBe("fnm_multishells");
  });

  test("rejects nvm, volta, asdf and nodenv version paths", () => {
    expect(volatileBinPath("/Users/nir/.nvm/versions/node/v22.3.0/bin/orc")).toBe(
      "/.nvm/versions/",
    );
    expect(volatileBinPath("/Users/nir/.volta/tools/image/node/22.3.0/bin/orc")).toBe(
      "/.volta/tools/",
    );
    expect(volatileBinPath("/Users/nir/.asdf/installs/nodejs/22.3.0/bin/orc")).toBe(
      "/.asdf/installs/",
    );
    expect(volatileBinPath("/Users/nir/.nodenv/versions/22.3.0/bin/orc")).toBe("nodenv/versions/");
  });

  test("accepts a stable path", () => {
    expect(volatileBinPath("/Users/nir/.local/bin/orc")).toBeNull();
    expect(volatileBinPath("/usr/local/bin/orc")).toBeNull();
    expect(volatileBinPath("/opt/homebrew/bin/orc")).toBeNull();
  });

  test("normalises Windows separators before matching", () => {
    expect(volatileBinPath("C:\\Users\\nir\\.volta\\tools\\image\\node\\22.3.0\\orc.exe")).toBe(
      "/.volta/tools/",
    );
  });
});

describe("macOS launchd agent", () => {
  test("restarts a crash but stays stopped after a clean daemon stop", () => {
    const plist = launchdPlist("/usr/local/bin/orc");
    // KeepAlive: true would respawn the daemon the moment `orc daemon stop`
    // exits 0, making stop look like it did nothing.
    expect(plist).toContain(
      "<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>",
    );
    expect(plist).not.toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain("<string>/usr/local/bin/orc</string>\n    <string>daemon</string>");
  });
});

describe("daemon logging and CLI session resolution (#533)", () => {
  test("openDaemonLogFd opens an appendable daemon log file and orc logs reads structured logs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orc-cli-logs-"));
    try {
      const daemonLog = join(dir, "daemon.log");
      const fd = openDaemonLogFd(daemonLog);
      try {
        writeFileSync(fd, "[WARN] 2026-11-24T00:00:00.000Z [api:chat] worker spawn failed\n");
      } finally {
        closeSync(fd);
      }
      expect(readFileSync(daemonLog, "utf8")).toContain("worker spawn failed");

      mkdirSync(join(dir, "logs"), { recursive: true });
      writeFileSync(
        join(dir, "logs", "orc.log"),
        `${JSON.stringify({
          ts: "2026-11-24T00:01:00.000Z",
          level: "error",
          ns: "api:chat",
          msg: "Chat turn failed",
          data: '{"error":"provider mismatch"}',
        })}\n`,
      );

      const proc = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "..", "index.ts"),
          "--json",
          "logs",
          "--local",
          "--source",
          "all",
          "--level",
          "warn",
        ],
        {
          env: { ...process.env, ORC_HOME: dir, ORC_LOG_DIR: dir },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const stdout = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      const parsed = JSON.parse(stdout) as { entries: { msg: string; source: string }[] };
      expect(
        parsed.entries.some((entry) => entry.msg === "Chat turn failed" && entry.source === "orc"),
      ).toBe(true);
      expect(
        parsed.entries.some(
          (entry) => entry.msg === "worker spawn failed" && entry.source === "daemon",
        ),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("orc session show resolves chat UUID, live record id, and native session id", async () => {
    const chatUuid = "11111111-2222-4333-8444-555555555555";
    const liveId = "01JABCDEF1234567890ABCDEFG";
    const nativeId = "ses_opencode_xyz";

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        const accepted = new Set([chatUuid, liveId, nativeId]);
        const statusMatch = url.pathname.match(/^\/api\/sessions\/live\/([^/]+)\/status$/);
        if (statusMatch?.[1] && accepted.has(decodeURIComponent(statusMatch[1]))) {
          return Response.json({
            session_id: chatUuid,
            live_session_id: liveId,
            native_session_id: nativeId,
            title: "Worker session",
            agent: "opencode",
            status: "running",
            waiting_for: null,
            last_message: null,
            queue: [],
            parent_session_id: null,
            children: [],
            working_children: 0,
            waiting_children: 0,
            stopping: false,
            project_id: null,
            cwd: "/tmp/work",
            started_at: 1_700_000_000_000,
            updated_at: 1_700_000_050_000,
            last_activity_at: 1_700_000_050_000,
            last_activity: "tool:bash",
            activity_count: 3,
            start_error: null,
          });
        }
        const liveMatch = url.pathname.match(/^\/api\/sessions\/live\/([^/]+)$/);
        if (liveMatch?.[1] && accepted.has(decodeURIComponent(liveMatch[1]))) {
          return Response.json({
            id: liveId,
            agent: "opencode",
            session_id: nativeId,
            name: "Worker session",
            summary: null,
            cwd: "/tmp/work",
            status: "running",
            project_id: null,
            last_activity_at: "2026-11-24T00:00:50.000Z",
            created_at: "2026-11-24T00:00:00.000Z",
          });
        }
        return Response.json({ error: "Not found" }, { status: 404 });
      },
    });

    try {
      for (const id of [chatUuid, liveId, nativeId]) {
        const proc = Bun.spawn(
          [
            process.execPath,
            join(import.meta.dir, "..", "index.ts"),
            "--json",
            "--host",
            "127.0.0.1",
            "--port",
            String(server.port),
            "session",
            "show",
            id,
          ],
          {
            env: {
              ...process.env,
              ORC_API_BASE: `http://127.0.0.1:${server.port}`,
              ORC_API_SECRET: "",
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const stdout = await new Response(proc.stdout).text();
        expect(await proc.exited).toBe(0);
        const body = JSON.parse(stdout) as {
          session_id: string;
          live_session_id: string;
          native_session_id: string;
          last_activity: string;
        };
        expect(body.session_id).toBe(chatUuid);
        expect(body.live_session_id).toBe(liveId);
        expect(body.native_session_id).toBe(nativeId);
        expect(body.last_activity).toBe("tool:bash");
      }
    } finally {
      server.stop(true);
    }
  });
});
