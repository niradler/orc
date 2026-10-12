import { Database } from "bun:sqlite";
import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { configuredApiSecret, loadConfig, type OrcConfig } from "./config.js";
import { OrcError, ValidationError } from "./errors.js";
import { ulid } from "./ids.js";

export interface SshExecHost {
  kind: "ssh";
  alias: string;
  remotePort: number;
  apiTarget: string;
  secret: string | undefined;
  connectTimeoutSecs: number;
}

export type ExecHost = { kind: "local" } | SshExecHost;

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  bytes?: Uint8Array;
}

export interface HostProbe {
  os: string;
  home: string;
  shell: string;
  binaries: Record<string, string | null>;
}

export interface HostProcess {
  proc: ReturnType<typeof Bun.spawn>;
  kill(): void;
}

export interface HostFileInfo {
  path: string;
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
}

export interface HostRuntime {
  readonly host: ExecHost;
  exec(argv: readonly string[], opts?: HostExecOptions): Promise<ExecResult>;
  spawn(argv: readonly string[], opts?: HostSpawnOptions): Promise<HostProcess>;
  home(): Promise<string>;
  binary(name: string): Promise<string | null>;
  isDirectory(path: string): Promise<boolean>;
  isFile(path: string): Promise<boolean>;
  stat(path: string): Promise<HostFileInfo | null>;
  readFile(path: string, maxBytes: number): Promise<Uint8Array>;
  listFiles(path: string, maxFiles?: number): Promise<HostFileInfo[]>;
  processAlive(pid: number): Promise<boolean>;
  sqliteQuery<T extends object>(path: string, sql: string): Promise<T[]>;
}

export interface HostSpawnOptions {
  cwd?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
  passEnv?: readonly string[] | undefined;
  stdin?: "pipe" | "ignore" | Uint8Array | undefined;
  stdout?: "pipe" | "ignore" | undefined;
  stderr?: "pipe" | "ignore" | undefined;
}

export interface HostExecOptions {
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  input?: string | Uint8Array | undefined;
  timeoutMs?: number | undefined;
  login?: boolean | undefined;
}

export class SshError extends OrcError {
  constructor(message: string) {
    super(message, "SSH_FAILED", 502);
    this.name = "SshError";
  }
}

export const LOCAL_HOST: ExecHost = { kind: "local" };

export const ALIAS_PATTERN = /^[A-Za-z0-9_.@][A-Za-z0-9_.@-]*$/;

const PROBE_BINARIES = [
  "claude",
  "codex",
  "cursor-agent",
  "agent",
  "gemini",
  "copilot",
  "acpx",
  "git",
  "bun",
  "node",
  "python3",
  "rg",
];

const FORWARD_PREFIXES = ["ANTHROPIC_", "OPENAI_", "GEMINI_", "GOOGLE_GENAI_"];
const FORWARD_KEYS = new Set([
  "GOOGLE_API_KEY",
  "ORC_ACTIVE_PROJECT",
  "ORC_PROJECT",
  "ORC_AGENT",
  "ORC_SESSION_ID",
  "ORC_JOB_RUN_ID",
  "ORC_RULE_ACTION",
  "COLORTERM",
  "TERM_PROGRAM",
]);

const LOGIN_SHELL =
  'case "$SHELL" in */bash|*/zsh|*/ksh|*/sh|*/dash) exec "$SHELL" -lc "$0" ;; *) exec /bin/sh -lc "$0" ;; esac';

const VERIFY_TTL_MS = 5_000;
const PROBE_TTL_MS = 30_000;

const pendingMasters = new Map<string, Promise<void>>();
const verifiedMasters = new Map<string, number>();
const probes = new Map<string, { at: number; probe: Promise<HostProbe> }>();
const liveProcesses = new Map<string, number>();
const retiring = new Set<string>();

export function resolveExecHost(config: OrcConfig = loadConfig()): ExecHost {
  return execHostFor(config.ssh.host ?? null, config);
}

export function execHostFor(alias: string | null, config: OrcConfig = loadConfig()): ExecHost {
  if (!alias) return LOCAL_HOST;
  if (!ALIAS_PATTERN.test(alias)) throw new ValidationError(`Invalid SSH host alias: ${alias}`);
  const bind = config.api.host;
  const target = ["0.0.0.0", "::", "", "localhost"].includes(bind) ? "127.0.0.1" : bind;
  return {
    kind: "ssh",
    alias,
    remotePort: config.ssh.remote_port ?? config.api.port,
    apiTarget: `${target.includes(":") ? `[${target}]` : target}:${config.api.port}`,
    secret: configuredApiSecret(config.api.secret),
    connectTimeoutSecs: config.ssh.connect_timeout_secs,
  };
}

export function hostAlias(host: ExecHost): string | null {
  return host.kind === "ssh" ? host.alias : null;
}

export function hostPlatform(host: ExecHost): NodeJS.Platform {
  return host.kind === "ssh" ? "linux" : process.platform;
}

export function orcUrlOnHost(host: SshExecHost): string {
  return `http://127.0.0.1:${host.remotePort}`;
}

export function shQuote(value: string): string {
  if (/^[A-Za-z0-9_/.,:=@%+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function shPath(path: string): string {
  if (path === "~") return '"$HOME"';
  if (path.startsWith("~/")) return `"$HOME"/${shQuote(path.slice(2))}`;
  return shQuote(path);
}

export interface RemoteCommandOptions {
  cwd?: string | undefined;
  envFile?: string | undefined;
  pidFile?: string | undefined;
  login?: boolean | undefined;
}

export function remoteCommand(argv: readonly string[], opts: RemoteCommandOptions = {}): string {
  const steps: string[] = [];
  if (opts.pidFile) steps.push(`echo $$ > ${shQuote(opts.pidFile)}`);
  if (opts.envFile) steps.push(`. ${shQuote(opts.envFile)}`, `rm -f ${shQuote(opts.envFile)}`);
  if (opts.cwd) steps.push(`cd ${shPath(opts.cwd)}`);
  steps.push(`exec ${argv.map(shQuote).join(" ")}`);
  const script = steps.join(" && ");
  if (opts.login === false) return `exec /bin/sh -c ${shQuote(script)}`;
  return `exec /bin/sh -c ${shQuote(LOGIN_SHELL)} ${shQuote(script)}`;
}

export function envScript(env: Record<string, string>): string {
  return Object.entries(env)
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    .map(([key, value]) => `export ${key}=${shQuote(value)}\n`)
    .join("");
}

export function forwardedEnv(
  host: SshExecHost,
  env: Record<string, string | undefined>,
  passEnv: readonly string[] = [],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (
      FORWARD_KEYS.has(key) ||
      passEnv.includes(key) ||
      FORWARD_PREFIXES.some((prefix) => key.startsWith(prefix))
    )
      out[key] = value;
  }
  out.ORC_API_BASE = orcUrlOnHost(host);
  if (host.secret) out.ORC_API_SECRET = host.secret;
  return out;
}

function sshDir(): string {
  return join(homedir(), ".orc", "ssh");
}

export function sshBinary(): string {
  if (process.platform === "win32")
    throw new ValidationError(
      "SSH host mode needs OpenSSH connection sharing, which Windows does not support. Run orc on Linux, macOS or in Docker to use an SSH host.",
    );
  const bin = Bun.which("ssh", { PATH: process.env.PATH ?? "" });
  if (!bin) throw new ValidationError("The OpenSSH client (ssh) is not installed where orc runs");
  return bin;
}

function commonOptions(host: Pick<SshExecHost, "connectTimeoutSecs">): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${host.connectTimeoutSecs}`,
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=4",
  ];
}

function masterOptions(host: Pick<SshExecHost, "connectTimeoutSecs">): string[] {
  return [...commonOptions(host), "-o", `ControlPath=${join(sshDir(), "%C")}`];
}

export function sshArgv(host: SshExecHost, remote: string, opts: { tty?: boolean } = {}): string[] {
  return [
    sshBinary(),
    ...commonOptions(host),
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    opts.tty ? "-tt" : "-T",
    host.alias,
    remote,
  ];
}

async function collect(proc: ReturnType<typeof Bun.spawn>): Promise<ExecResult> {
  const [buffer, stderr, code] = await Promise.all([
    proc.stdout instanceof ReadableStream
      ? new Response(proc.stdout).arrayBuffer()
      : new ArrayBuffer(0),
    proc.stderr instanceof ReadableStream ? new Response(proc.stderr).text() : "",
    proc.exited,
  ]);
  const bytes = new Uint8Array(buffer);
  return { code, stdout: new TextDecoder().decode(bytes), stderr, bytes };
}

async function controlCommand(
  alias: string,
  command: "check" | "exit",
  connectTimeoutSecs = 10,
): Promise<boolean> {
  const proc = Bun.spawn(
    [sshBinary(), ...masterOptions({ connectTimeoutSecs }), "-O", command, alias],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 10_000 },
  );
  return (await proc.exited) === 0;
}

export function describeSshFailure(alias: string, log: string): string {
  const text = log.trim();
  if (/host key verification failed|no .* host key is known/i.test(text))
    return `The host key for ${alias} is not trusted yet. Run "ssh ${alias}" once where orc runs and accept it.`;
  if (/permission denied/i.test(text))
    return `${alias} rejected the login. orc cannot answer password prompts, so configure a key (IdentityFile in ~/.ssh/config or ssh-agent).`;
  if (/remote port forwarding failed/i.test(text))
    return `${alias} refused the reverse tunnel: its port is already in use. Set ssh.remote_port to a free port.`;
  if (/could not resolve hostname/i.test(text))
    return `${alias} does not resolve. Check the HostName in ~/.ssh/config.`;
  if (/bad owner or permissions/i.test(text))
    return `ssh refuses to read your SSH config or key: ${text.split("\n").pop()}. Fix ownership and permissions (chmod 600).`;
  if (/connection timed out|operation timed out/i.test(text))
    return `Connecting to ${alias} timed out.`;
  const last = text.split("\n").filter(Boolean).slice(-3).join(" ");
  return `Could not connect to ${alias}${last ? `: ${last}` : ""}`;
}

async function startMaster(host: SshExecHost): Promise<void> {
  mkdirSync(sshDir(), { recursive: true, mode: 0o700 });
  const forward = `${host.remotePort}:${host.apiTarget}`;
  const stateFile = join(sshDir(), `${host.alias}.forward`);
  const current = existsSync(stateFile) ? readFileSync(stateFile, "utf8") : "";
  // In colocated Docker installs the API is already reachable on the SSH
  // host, so no persistent connection or reverse tunnel is needed. Keeping a
  // direct-mode ControlMaster would only consume a process and leave ordinary
  // PTYs dependent on its socket.
  if (current === "direct" && (await remoteApiReachable(host))) return;
  if (await controlCommand(host.alias, "check")) {
    if (current === forward) return;
    await controlCommand(host.alias, "exit");
  }
  const log = join(sshDir(), `${host.alias}.log`);
  writeFileSync(log, "", { mode: 0o600 });
  const proc = Bun.spawn(
    [
      sshBinary(),
      ...masterOptions(host),
      "-o",
      "ControlMaster=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-f",
      "-N",
      "-R",
      forward,
      host.alias,
    ],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: Bun.file(log),
      timeout: (host.connectTimeoutSecs + 20) * 1000,
    },
  );
  if ((await proc.exited) !== 0) {
    const failure = readFileSync(log, "utf8");
    // A colocated Docker deployment can already expose ORC on the SSH host's
    // loopback port. In that case a reverse forward cannot bind the port, but
    // agents can still reach the authenticated API directly from the host.
    if (/remote port forwarding failed/i.test(failure) && (await remoteApiReachable(host))) {
      writeFileSync(stateFile, "direct", { mode: 0o600 });
      return;
    }
    throw new SshError(describeSshFailure(host.alias, failure));
  }
  writeFileSync(stateFile, forward, { mode: 0o600 });
}

async function remoteApiReachable(host: SshExecHost): Promise<boolean> {
  const result = Bun.spawn(
    [
      sshBinary(),
      ...commonOptions(host),
      "-o",
      "ControlMaster=no",
      "-o",
      "ControlPath=none",
      "-T",
      host.alias,
      remoteCommand(
        [
          "curl",
          "-fsS",
          "--max-time",
          "3",
          ...(host.secret ? ["-H", `Authorization: Bearer ${host.secret}`] : []),
          `${orcUrlOnHost(host)}/api/ssh`,
        ],
        { login: false },
      ),
    ],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      timeout: (host.connectTimeoutSecs + 5) * 1000,
    },
  );
  return (await result.exited) === 0;
}

export async function ensureSshMaster(host: SshExecHost): Promise<void> {
  const key = `${host.alias}|${host.remotePort}|${host.apiTarget}`;
  retiring.delete(host.alias);
  if ((verifiedMasters.get(key) ?? 0) > Date.now() - VERIFY_TTL_MS) return;
  let pending = pendingMasters.get(host.alias);
  if (!pending) {
    pending = startMaster(host).finally(() => pendingMasters.delete(host.alias));
    pendingMasters.set(host.alias, pending);
  }
  await pending;
  verifiedMasters.set(key, Date.now());
}

function forgetHost(alias: string): void {
  for (const key of verifiedMasters.keys())
    if (key.startsWith(`${alias}|`)) verifiedMasters.delete(key);
  probes.delete(alias);
}

export function trackHostProcess(alias: string, exited: Promise<unknown>): void {
  liveProcesses.set(alias, (liveProcesses.get(alias) ?? 0) + 1);
  void exited.finally(() => {
    const left = (liveProcesses.get(alias) ?? 1) - 1;
    if (left > 0) {
      liveProcesses.set(alias, left);
      return;
    }
    liveProcesses.delete(alias);
    if (retiring.has(alias)) void closeSshMaster(alias);
  });
}

async function closeSshMaster(alias: string): Promise<void> {
  retiring.delete(alias);
  forgetHost(alias);
  try {
    await controlCommand(alias, "exit");
  } catch {}
}

export async function retireSshMaster(alias: string): Promise<void> {
  if (liveProcesses.get(alias)) {
    retiring.add(alias);
    forgetHost(alias);
    return;
  }
  await closeSshMaster(alias);
}

export async function hostExec(
  host: ExecHost,
  argv: readonly string[],
  opts: HostExecOptions = {},
): Promise<ExecResult> {
  const input =
    opts.input === undefined
      ? "ignore"
      : typeof opts.input === "string"
        ? new TextEncoder().encode(opts.input)
        : opts.input;
  if (host.kind === "local") {
    return collect(
      Bun.spawn([...argv], {
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        env: { ...process.env, ...opts.env },
        stdin: input,
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
        ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
      }),
    );
  }
  await ensureSshMaster(host);
  const withEnv = opts.env
    ? ["env", ...Object.entries(opts.env).map(([k, v]) => `${k}=${v}`), ...argv]
    : argv;
  return collect(
    Bun.spawn(sshArgv(host, remoteCommand(withEnv, { cwd: opts.cwd, login: opts.login })), {
      env: process.env,
      stdin: input,
      stdout: "pipe",
      stderr: "pipe",
      ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
    }),
  );
}

export async function writeHostFile(
  host: SshExecHost,
  path: string,
  content: string,
): Promise<void> {
  const result = await hostExec(host, ["/bin/sh", "-c", 'umask 077 && cat > "$1"', "sh", path], {
    input: content,
    login: false,
  });
  if (result.code !== 0)
    throw new SshError(`Could not write ${path} on ${host.alias}: ${result.stderr.trim()}`);
}

export async function removeHostFile(host: SshExecHost, path: string): Promise<void> {
  await hostExec(host, ["rm", "-f", path], { login: false }).catch(() => undefined);
}

export function remoteTempPath(suffix: string): string {
  return `/tmp/orc-${ulid().toLowerCase()}${suffix}`;
}

export async function hostSpawn(
  host: ExecHost,
  argv: readonly string[],
  opts: HostSpawnOptions = {},
): Promise<HostProcess> {
  const stdio = {
    stdin: opts.stdin ?? "ignore",
    stdout: opts.stdout ?? "pipe",
    stderr: opts.stderr ?? "pipe",
  } as const;
  if (host.kind === "local") {
    const proc = Bun.spawn({
      cmd: [...argv],
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env ? { env: opts.env as Record<string, string> } : {}),
      ...stdio,
    }) as ReturnType<typeof Bun.spawn>;
    return {
      proc,
      kill: () => {
        try {
          proc.kill();
        } catch {}
      },
    };
  }
  const prepared = await prepareSshSpawn(host, opts);
  const proc = Bun.spawn({
    cmd: prepared.argv(argv, opts.cwd),
    env: process.env,
    ...stdio,
  }) as ReturnType<typeof Bun.spawn>;
  prepared.track(proc.exited);
  return {
    proc,
    kill: () => {
      void prepared.stop().finally(() => {
        try {
          proc.kill();
        } catch {}
      });
    },
  };
}

export interface PreparedSshSpawn {
  argv(command: readonly string[], cwd?: string | undefined): string[];
  track(exited: Promise<unknown>): void;
  stop(): Promise<void>;
}

export async function prepareSshSpawn(
  host: SshExecHost,
  opts: Pick<HostSpawnOptions, "env" | "passEnv"> = {},
): Promise<PreparedSshSpawn> {
  await ensureSshMaster(host);
  const envFile = remoteTempPath(".env");
  const pidFile = remoteTempPath(".pid");
  await writeHostFile(
    host,
    envFile,
    envScript(forwardedEnv(host, opts.env ?? process.env, opts.passEnv)),
  );
  let stopped = false;
  return {
    argv: (command, cwd) => sshArgv(host, remoteCommand(command, { cwd, envFile, pidFile })),
    track: (exited) => {
      trackHostProcess(host.alias, exited);
      void exited.then(() => {
        if (!stopped) void removeHostFile(host, pidFile);
      });
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await signalRemote(host, pidFile);
    },
  };
}

async function signalRemote(host: SshExecHost, pidFile: string): Promise<void> {
  await hostExec(
    host,
    [
      "/bin/sh",
      "-c",
      'p=$(cat "$1" 2>/dev/null) && { kill -TERM -"$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null; }; rm -f "$1"',
      "sh",
      pidFile,
    ],
    { login: false, timeoutMs: 10_000 },
  ).catch(() => undefined);
}

export function parseProbe(stdout: string): HostProbe {
  const probe: HostProbe = { os: "", home: "", shell: "", binaries: {} };
  for (const line of stdout.split("\n")) {
    const at = line.indexOf("=");
    if (at < 0) continue;
    const key = line.slice(0, at);
    const value = line.slice(at + 1).trim();
    if (key === "os") probe.os = value;
    else if (key === "home") probe.home = value;
    else if (key === "shell") probe.shell = value;
    else if (key.startsWith("bin."))
      probe.binaries[key.slice(4)] = value.startsWith("/") ? value : null;
  }
  return probe;
}

async function runProbe(host: SshExecHost): Promise<HostProbe> {
  const script = [
    'printf "os=%s\\n" "$(uname -s)"',
    'printf "home=%s\\n" "$HOME"',
    'printf "shell=%s\\n" "$SHELL"',
    `for b in ${PROBE_BINARIES.join(" ")}; do printf "bin.%s=%s\\n" "$b" "$(command -v "$b" 2>/dev/null)"; done`,
  ].join("; ");
  const result = await hostExec(host, ["/bin/sh", "-c", script], {
    timeoutMs: 30_000,
  });
  if (result.code !== 0)
    throw new SshError(describeSshFailure(host.alias, result.stderr || result.stdout));
  const probe = parseProbe(result.stdout);
  if (!/^(Linux|Darwin|FreeBSD|OpenBSD|NetBSD)$/.test(probe.os))
    throw new SshError(
      `${host.alias} reports OS "${probe.os || "unknown"}"; SSH host mode needs a Linux, macOS or BSD host`,
    );
  if (!probe.home.startsWith("/")) throw new SshError(`${host.alias} did not report a home folder`);
  return probe;
}

export async function probeHost(host: SshExecHost, fresh = false): Promise<HostProbe> {
  const cached = probes.get(host.alias);
  if (!fresh && cached && cached.at > Date.now() - PROBE_TTL_MS) return cached.probe;
  const probe = runProbe(host);
  probes.set(host.alias, { at: Date.now(), probe });
  probe.catch(() => probes.delete(host.alias));
  return probe;
}

export async function hostBinary(host: ExecHost, name: string): Promise<string | null> {
  if (host.kind === "local") return Bun.which(name, { PATH: process.env.PATH ?? "" });
  return (await probeHost(host)).binaries[name] ?? null;
}

export async function expandHostPath(host: ExecHost, path: string): Promise<string> {
  if (host.kind === "local" || (path !== "~" && !path.startsWith("~/"))) return path;
  const { home } = await probeHost(host);
  return path === "~" ? home : `${home}/${path.slice(2)}`;
}

export async function hostHome(host: ExecHost): Promise<string> {
  return host.kind === "local" ? homedir() : (await probeHost(host)).home;
}

export async function hostIsDirectory(host: ExecHost, path: string): Promise<boolean> {
  if (host.kind === "local") {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  }
  const result = await hostExec(host, ["test", "-d", await expandHostPath(host, path)], {
    login: false,
  });
  return result.code === 0;
}

export async function hostIsFile(host: ExecHost, path: string): Promise<boolean> {
  const target = await expandHostPath(host, path);
  if (host.kind === "local") {
    try {
      return statSync(target).isFile();
    } catch {
      return false;
    }
  }
  const result = await hostExec(host, ["test", "-f", target], { login: false });
  return result.code === 0;
}

export async function readHostFile(
  host: ExecHost,
  path: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const target = await expandHostPath(host, path);
  if (host.kind === "local") {
    const stat = statSync(target);
    if (!stat.isFile()) throw new ValidationError(`Not a readable file: ${target}`);
    if (stat.size > maxBytes) throw new ValidationError(`File is too large to read: ${target}`);
    return new Uint8Array(await Bun.file(target).arrayBuffer());
  }
  const size = await hostExec(host, ["wc", "-c", target], {
    login: false,
    timeoutMs: 30_000,
  });
  if (size.code !== 0) throw new ValidationError(`Not a readable file: ${target}`);
  const bytes = Number.parseInt(size.stdout.trim().split(/\s+/)[0] ?? "", 10);
  if (!Number.isFinite(bytes))
    throw new ValidationError(`Could not determine file size: ${target}`);
  if (bytes > maxBytes) throw new ValidationError(`File is too large to read: ${target}`);
  const result = await hostExec(host, ["cat", target], {
    login: false,
    timeoutMs: 60_000,
  });
  if (result.code !== 0) throw new ValidationError(`Could not read file: ${target}`);
  return result.bytes ?? new TextEncoder().encode(result.stdout);
}

const REMOTE_LIST_FILES = `
import json, os, sys
request = json.load(sys.stdin)
root = os.path.expanduser(request["path"])
limit = int(request["limit"])
out = []
if os.path.isdir(root):
  for current, dirs, files in os.walk(root, followlinks=False):
    dirs[:] = [name for name in dirs if not os.path.islink(os.path.join(current, name))]
    for name in files:
      path = os.path.join(current, name)
      try:
        stat = os.stat(path, follow_symlinks=False)
        if not os.path.isfile(path) or os.path.islink(path):
          continue
        out.append({"path": path, "size": stat.st_size, "mtimeMs": stat.st_mtime * 1000,
                    "birthtimeMs": getattr(stat, "st_birthtime", stat.st_ctime) * 1000})
        if len(out) >= limit:
          print(json.dumps(out))
          raise SystemExit(0)
      except OSError:
        pass
print(json.dumps(out))
`;

const REMOTE_STAT = `
import json, os, sys
path = os.path.expanduser(json.load(sys.stdin)["path"])
try:
  stat = os.stat(path, follow_symlinks=False)
  if not os.path.isfile(path) or os.path.islink(path):
    print("null")
  else:
    print(json.dumps({"path": path, "size": stat.st_size, "mtimeMs": stat.st_mtime * 1000,
                      "birthtimeMs": getattr(stat, "st_birthtime", stat.st_ctime) * 1000}))
except OSError:
  print("null")
`;

const REMOTE_SQLITE_QUERY = `
import json, os, pathlib, sqlite3, sys
request = json.load(sys.stdin)
path = os.path.expanduser(request["path"])
uri = pathlib.Path(path).resolve().as_uri() + "?mode=ro"
db = sqlite3.connect(uri, uri=True, timeout=2)
db.row_factory = sqlite3.Row
try:
  print(json.dumps([dict(row) for row in db.execute(request["sql"]).fetchall()]))
finally:
  db.close()
`;

async function remotePythonJson<T>(
  host: SshExecHost,
  source: string,
  input: Record<string, unknown>,
): Promise<T> {
  const python = await hostBinary(host, "python3");
  if (!python)
    throw new ValidationError(
      `python3 is required on SSH host ${host.alias} for host filesystem and SQLite inspection`,
    );
  const result = await hostExec(host, [python, "-c", source], {
    input: JSON.stringify(input),
    login: false,
    timeoutMs: 60_000,
  });
  if (result.code !== 0)
    throw new SshError(result.stderr.trim() || `Host helper failed on ${host.alias}`);
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new SshError(`Host helper on ${host.alias} returned invalid JSON`);
  }
}

export async function listHostFiles(
  host: ExecHost,
  path: string,
  maxFiles = 20_000,
): Promise<HostFileInfo[]> {
  const target = await expandHostPath(host, path);
  if (host.kind === "ssh") {
    return remotePythonJson<HostFileInfo[]>(host, REMOTE_LIST_FILES, {
      path: target,
      limit: maxFiles,
    });
  }
  const files: HostFileInfo[] = [];
  const visit = (directory: string): void => {
    if (files.length >= maxFiles) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, {
        withFileTypes: true,
        encoding: "utf8",
      });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles || entry.isSymbolicLink()) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        const stat = statSync(full);
        files.push({
          path: full,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          birthtimeMs: stat.birthtimeMs || stat.ctimeMs,
        });
      }
    }
  };
  visit(target);
  return files;
}

export async function statHostFile(host: ExecHost, path: string): Promise<HostFileInfo | null> {
  const target = await expandHostPath(host, path);
  if (host.kind === "ssh")
    return remotePythonJson<HostFileInfo | null>(host, REMOTE_STAT, {
      path: target,
    });
  try {
    const stat = statSync(target);
    if (!stat.isFile()) return null;
    return {
      path: target,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      birthtimeMs: stat.birthtimeMs || stat.ctimeMs,
    };
  } catch {
    return null;
  }
}

export async function hostProcessAlive(host: ExecHost, pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (host.kind === "local") {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }
  return (await hostExec(host, ["kill", "-0", String(pid)], { login: false })).code === 0;
}

export async function hostSqliteQuery<T extends object>(
  host: ExecHost,
  path: string,
  sql: string,
): Promise<T[]> {
  const target = await expandHostPath(host, path);
  if (host.kind === "ssh") {
    return remotePythonJson<T[]>(host, REMOTE_SQLITE_QUERY, {
      path: target,
      sql,
    });
  }
  const db = new Database(target, { readonly: true });
  try {
    return db.query<T, []>(sql).all();
  } finally {
    db.close();
  }
}

export function hostRuntime(host: ExecHost = resolveExecHost()): HostRuntime {
  return {
    host,
    exec: (argv, opts) => hostExec(host, argv, opts),
    spawn: (argv, opts) => hostSpawn(host, argv, opts),
    home: () => hostHome(host),
    binary: (name) => hostBinary(host, name),
    isDirectory: (path) => hostIsDirectory(host, path),
    isFile: (path) => hostIsFile(host, path),
    stat: (path) => statHostFile(host, path),
    readFile: (path, maxBytes) => readHostFile(host, path, maxBytes),
    listFiles: (path, maxFiles) => listHostFiles(host, path, maxFiles),
    processAlive: (pid) => hostProcessAlive(host, pid),
    sqliteQuery: <T extends object>(path: string, sql: string) =>
      hostSqliteQuery<T>(host, path, sql),
  };
}

export async function hostMakeDirectory(host: ExecHost, path: string): Promise<void> {
  if (host.kind === "local") {
    mkdirSync(path, { recursive: true });
    return;
  }
  const result = await hostExec(host, ["mkdir", "-p", "--", path], {
    login: false,
  });
  if (result.code !== 0) throw new ValidationError(result.stderr.trim() || `mkdir ${path} failed`);
}

export interface DirectoryListing {
  path: string;
  parent: string | null;
  directories: string[];
}

export async function listHostDirectories(host: ExecHost, path: string): Promise<DirectoryListing> {
  const target = await expandHostPath(host, path || "~");
  if (!isAbsolute(target)) throw new ValidationError("Choose an absolute folder path");
  let canonical: string;
  let directories: string[];
  if (host.kind === "local") {
    canonical = target;
    try {
      directories = readdirSync(target, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name);
    } catch {
      throw new ValidationError(`Not a readable folder: ${target}`);
    }
  } else {
    const result = await hostExec(
      host,
      [
        "/bin/sh",
        "-c",
        'cd -P -- "$1" 2>/dev/null || exit 3; pwd -P; for f in *; do if [ -d "$f" ] && [ ! -L "$f" ]; then printf "%s\\n" "$f"; fi; done',
        "sh",
        target,
      ],
      { login: false },
    );
    if (result.code !== 0) throw new ValidationError(`Not a readable folder: ${target}`);
    const [first = target, ...rest] = result.stdout.split("\n");
    canonical = first;
    directories = rest.filter(Boolean);
  }
  directories.sort((a, b) => a.localeCompare(b));
  const parent = dirname(canonical);
  return {
    path: canonical,
    parent: parent === canonical ? null : parent,
    directories: directories.slice(0, 1000),
  };
}

function expandSshPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? path : join(homedir(), ".ssh", path);
}

function includedFiles(pattern: string): string[] {
  const full = expandSshPath(pattern);
  const dir = dirname(full);
  const name = basename(full);
  if (!/[*?[]/.test(name)) return existsSync(full) ? [full] : [];
  try {
    const glob = new Bun.Glob(name);
    return readdirSync(dir)
      .filter((entry) => glob.match(entry))
      .sort()
      .map((entry) => join(dir, entry));
  } catch {
    return [];
  }
}

function unquote(token: string): string {
  return token.length > 1 && token.startsWith('"') && token.endsWith('"')
    ? token.slice(1, -1)
    : token;
}

export function parseSshConfigHosts(
  text: string,
  include: (pattern: string) => string[] = () => [],
): string[] {
  const hosts: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(\S+?)(?:\s*=\s*|\s+)(.+)$/.exec(line);
    if (!match?.[1] || !match[2]) continue;
    const key = match[1].toLowerCase();
    const tokens = match[2].split(/\s+/).map(unquote);
    if (key === "include") {
      for (const pattern of tokens) hosts.push(...include(pattern));
      continue;
    }
    if (key !== "host") continue;
    for (const token of tokens) {
      if (/[*?!]/.test(token) || !ALIAS_PATTERN.test(token)) continue;
      hosts.push(token);
    }
  }
  return [...new Set(hosts)];
}

export function listSshConfigHosts(path = join(homedir(), ".ssh", "config")): string[] {
  const seen = new Set<string>();
  const read = (file: string, depth: number): string[] => {
    if (depth > 8 || seen.has(file)) return [];
    seen.add(file);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return [];
    }
    return parseSshConfigHosts(text, (pattern) =>
      includedFiles(pattern).flatMap((included) => read(included, depth + 1)),
    );
  };
  return [...new Set(read(path, 0))];
}
