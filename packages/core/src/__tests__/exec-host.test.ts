import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import {
  describeSshFailure,
  envScript,
  execHostFor,
  forwardedEnv,
  parseProbe,
  parseSshConfigHosts,
  remoteCommand,
  type SshExecHost,
  shQuote,
  sshArgv,
} from "../exec-host.js";

const host: SshExecHost = {
  kind: "ssh",
  alias: "box",
  remotePort: 7799,
  apiTarget: "127.0.0.1:7700",
  secret: "s3cret",
  connectTimeoutSecs: 10,
};

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
      remotePort: 7701,
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

// sshBinary() refuses Windows: SSH host mode needs OpenSSH connection sharing.
describe.skipIf(process.platform === "win32")("sshArgv", () => {
  test("keeps ordinary commands independent from control sockets", () => {
    const argv = sshArgv(host, "true", { tty: true });
    expect(argv).toContain("ControlMaster=no");
    expect(argv).toContain("ControlPath=none");
    expect(argv).not.toContain("ControlMaster=yes");
    expect(argv).toContain("-tt");
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
