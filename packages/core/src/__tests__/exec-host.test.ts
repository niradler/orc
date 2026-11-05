import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import {
  connectionSharing,
  describeSshFailure,
  envScript,
  execHostFor,
  expandHostPath,
  forwardedEnv,
  isSshTransportFailure,
  LOCAL_HOST,
  listHostDirectories,
  parseProbe,
  parseSshConfigHosts,
  parseTunnelReady,
  remoteCommand,
  retryTransientSqlite,
  type SshExecHost,
  shQuote,
  sshArgv,
  sshMasterArgv,
  sshTunnelArgv,
} from "../exec-host.js";

const host: SshExecHost = {
  kind: "ssh",
  alias: "box",
  remotePort: 7799,
  apiTarget: "127.0.0.1:7700",
  secret: "s3cret",
  connectTimeoutSecs: 10,
};

test("should resolve local home paths and list the default folder", async () => {
  expect(await expandHostPath(LOCAL_HOST, "~")).toBe(homedir());
  expect(await expandHostPath(LOCAL_HOST, "~/projects")).toBe(join(homedir(), "projects"));
  expect(await expandHostPath(LOCAL_HOST, "/literal/path")).toBe("/literal/path");
  expect((await listHostDirectories(LOCAL_HOST, "")).path).toBe(homedir());
});

async function runRemote(script: string): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(["sh", "-c", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  return { code: await proc.exited, stdout };
}

describe("shQuote", () => {
  test("survives a round trip through sh for hostile values", async () => {
    const values = ["plain", "it's", 'a "b" $HOME `id` \\n', "", "--flag", "x;rm -rf /"];
    for (const value of values) {
      const { stdout } = await runRemote(`printf %s ${shQuote(value)}`);
      expect(stdout).toBe(value);
    }
  });
});

describe("remoteCommand", () => {
  test("sources and deletes the env file, records its pid, and runs argv in cwd", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "orc-exec-host-")));
    const envFile = join(dir, "env");
    const pidFile = join(dir, "pid");
    writeFileSync(envFile, envScript({ ORC_TEST_VALUE: "it's $not expanded", "BAD-KEY": "x" }));
    // A relative read proves the cwd without comparing path formats (MSYS pwd prints /tmp/...).
    writeFileSync(join(dir, "marker"), "in-cwd");
    const script = remoteCommand(
      ["/bin/sh", "-c", 'printf "%s|%s" "$ORC_TEST_VALUE" "$(cat marker)"'],
      {
        cwd: dir,
        envFile,
        pidFile,
        login: false,
      },
    );
    const { code, stdout } = await runRemote(script);
    expect(code).toBe(0);
    expect(stdout).toBe("it's $not expanded|in-cwd");
    expect(existsSync(envFile)).toBe(false);
    expect(Number(readFileSync(pidFile, "utf8").trim())).toBeGreaterThan(0);
  });

  test("expands a leading ~ in cwd to the remote home", async () => {
    const script = remoteCommand(["/bin/sh", "-c", "pwd"], {
      cwd: "~",
      login: false,
    });
    const { stdout } = await runRemote(`HOME=/tmp; ${script}`);
    expect(realpathSync(stdout.trim())).toBe(realpathSync("/tmp"));
  });

  test("fails instead of running in the wrong folder when cwd is missing", async () => {
    const script = remoteCommand(["/bin/echo", "ran"], {
      cwd: "/no/such/dir",
      login: false,
    });
    const { code, stdout } = await runRemote(script);
    expect(code).not.toBe(0);
    expect(stdout).toBe("");
  });
});

describe("forwardedEnv", () => {
  test("should request an available SSH port when no override is configured", () => {
    const automatic = execHostFor("box", loadConfig({ ssh: { connect_timeout_secs: 10 } }));
    expect(automatic.kind === "ssh" && automatic.remotePort).toBe(0);
  });
  test("forwards only allowlisted keys and points the agent at the tunnel", () => {
    const env = forwardedEnv(
      host,
      {
        ANTHROPIC_API_KEY: "k",
        OPENAI_API_KEY: "o",
        ORC_JOB_RUN_ID: "run",
        CUSTOM: "c",
        AWS_SECRET_ACCESS_KEY: "nope",
        PATH: "/local/bin",
        HOME: "/Users/me",
        UNSET: undefined,
      },
      ["CUSTOM"],
    );
    expect(env).toEqual({
      ANTHROPIC_API_KEY: "k",
      OPENAI_API_KEY: "o",
      ORC_JOB_RUN_ID: "run",
      CUSTOM: "c",
      ORC_API_BASE: "http://127.0.0.1:7799",
      ORC_API_SECRET: "s3cret",
    });
  });
});

describe("execHostFor", () => {
  test("tunnels to loopback when the API binds every interface", () => {
    const config = loadConfig();
    const resolved = execHostFor("box", {
      ...config,
      api: { ...config.api, host: "0.0.0.0", port: 7701 },
      ssh: { ...config.ssh, remote_port: undefined },
    });
    expect(resolved).toMatchObject({
      kind: "ssh",
      apiTarget: "127.0.0.1:7701",
      remotePort: 0,
    });
  });

  test("brackets an IPv6 bind address and rejects option-like aliases", () => {
    const config = loadConfig();
    const resolved = execHostFor("box", {
      ...config,
      api: { ...config.api, host: "fd00::1" },
    });
    expect(resolved).toMatchObject({
      apiTarget: `[fd00::1]:${config.api.port}`,
    });
    expect(() => execHostFor("-oProxyCommand=id", config)).toThrow();
  });

  test("an empty alias means local", () => {
    expect(execHostFor(null)).toEqual({ kind: "local" });
  });
});

describe("sshArgv", () => {
  test("keeps long-lived commands independent from control sockets", () => {
    const argv = sshArgv(host, "true", { tty: true });
    expect(argv).toContain("ControlMaster=no");
    expect(argv).toContain("ControlPath=none");
    expect(argv).not.toContain("ControlMaster=yes");
    expect(argv).toContain("-tt");
  });

  test("reuses the control socket for ordinary commands", () => {
    if (process.platform === "win32") return;
    const argv = sshArgv(host, "true", { shared: true });
    expect(argv).toContain("ControlMaster=no");
    expect(argv).not.toContain("ControlPath=none");
    expect(argv.some((arg) => arg.includes("ControlPath=") && arg.endsWith("/.orc/ssh/%C"))).toBe(
      true,
    );
    expect(argv).toContain("-T");
  });

  test("uses one connection per command where OpenSSH cannot share connections", () => {
    expect(connectionSharing("win32")).toBe(false);
    expect(connectionSharing("linux")).toBe(true);
    if (process.platform !== "win32") return;
    const argv = sshArgv(host, "true", { shared: true });
    expect(argv).toContain("ControlPath=none");
    expect(argv).not.toContain("ProxyCommand=false");
  });

  test("keeps the reverse tunnel in its own foreground process", () => {
    const argv = sshTunnelArgv(host, "127.0.0.1:0:127.0.0.1:7700");
    expect(argv).toContain("-N");
    expect(argv).toContain("ExitOnForwardFailure=yes");
    expect(argv).toContain("ControlPath=none");
    expect(argv).not.toContain("-f");
    expect(argv.slice(-3)).toEqual(["-R", "127.0.0.1:0:127.0.0.1:7700", "box"]);
  });

  test("starts direct and forwarded control masters without mixing their modes", () => {
    if (process.platform === "win32") return;
    const direct = sshMasterArgv(host, null);
    const forwarded = sshMasterArgv(host, "7799:127.0.0.1:7700");
    expect(direct).toContain("ControlMaster=yes");
    expect(direct).not.toContain("-R");
    expect(forwarded.slice(forwarded.indexOf("-R"), forwarded.indexOf("-R") + 2)).toEqual([
      "-R",
      "7799:127.0.0.1:7700",
    ]);
  });
});

describe("parseTunnelReady", () => {
  test("waits for every forward reply and reads the allocated port", () => {
    expect(parseTunnelReady("debug1: Authenticated to box").ready).toBe(false);
    expect(
      parseTunnelReady(
        "Allocated port 42607 for remote forward to 127.0.0.1:7700\r\ndebug1: forwarding_success: all expected forwarding replies received",
      ),
    ).toEqual({ ready: true, port: 42607 });
    expect(
      parseTunnelReady("debug1: forwarding_success: all expected forwarding replies received"),
    ).toEqual({ ready: true, port: null });
  });
});

describe("isSshTransportFailure", () => {
  test("recognizes broken transports without treating remote command errors as connection loss", () => {
    expect(isSshTransportFailure("mux_client_request_session: read from master failed")).toBe(true);
    expect(isSshTransportFailure("kex_exchange_identification: Connection reset by peer")).toBe(
      true,
    );
    expect(isSshTransportFailure("remote command exited with status 255")).toBe(false);
  });
});

describe("parseSshConfigHosts", () => {
  test("lists concrete aliases, skips patterns and follows Include", () => {
    const text = [
      "# comment",
      "Host *",
      "  ServerAliveInterval 30",
      "Host dev prod-1 *.internal !bastion",
      "  HostName 10.0.0.1",
      'host="quoted"',
      "Include extra/*",
      "Host dev",
    ].join("\n");
    const hosts = parseSshConfigHosts(text, (pattern) =>
      pattern === "extra/*" ? ["gpu", "dev"] : [],
    );
    expect(hosts).toEqual(["dev", "prod-1", "quoted", "gpu"]);
  });
});

describe("parseProbe", () => {
  test("reads os, home, shell and resolved binaries", () => {
    const probe = parseProbe(
      [
        "os=Linux",
        "home=/home/me",
        "shell=/usr/bin/fish",
        "bin.claude=/home/me/.local/bin/claude",
        "bin.codex=",
        "bin.git=git: aliased",
      ].join("\n"),
    );
    expect(probe).toEqual({
      os: "Linux",
      home: "/home/me",
      shell: "/usr/bin/fish",
      binaries: {
        claude: "/home/me/.local/bin/claude",
        codex: null,
        git: null,
      },
    });
  });
});

describe("describeSshFailure", () => {
  test("turns ssh errors into actionable messages", () => {
    expect(describeSshFailure("box", "Host key verification failed.")).toContain("box");
    expect(
      describeSshFailure("box", "Error: remote port forwarding failed for listen port 7700"),
    ).toMatch(/port/i);
  });
});

describe("retryTransientSqlite", () => {
  const sqliteError = (code: string) => Object.assign(new Error(code), { code });

  test("retries a transient SQLite failure and returns the next result", async () => {
    let calls = 0;
    const rows = await retryTransientSqlite(
      () => {
        calls++;
        if (calls === 1) throw sqliteError("SQLITE_IOERR_TRUNCATE");
        return ["row"];
      },
      3,
      1,
    );
    expect(rows).toEqual(["row"]);
    expect(calls).toBe(2);
  });

  test("throws non-transient errors immediately and gives up after the attempt limit", async () => {
    let calls = 0;
    const corrupt = () => {
      calls++;
      throw sqliteError("SQLITE_CORRUPT");
    };
    await expect(retryTransientSqlite(corrupt, 3, 1)).rejects.toThrow("SQLITE_CORRUPT");
    expect(calls).toBe(1);
    calls = 0;
    const busy = () => {
      calls++;
      throw sqliteError("SQLITE_BUSY");
    };
    await expect(retryTransientSqlite(busy, 3, 1)).rejects.toThrow("SQLITE_BUSY");
    expect(calls).toBe(3);
  });
});
