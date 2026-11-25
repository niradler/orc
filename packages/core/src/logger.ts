import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { orcHome } from "./home.js";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogSource = "orc" | "daemon" | "all";

export type LogEntry = {
  ts: string | null;
  level: LogLevel | null;
  ns: string | null;
  msg: string;
  data?: string | undefined;
  source: "orc" | "daemon";
};

export type ReadLogsOptions = {
  lines?: number | undefined;
  level?: LogLevel | undefined;
  ns?: string | undefined;
  q?: string | undefined;
  source?: LogSource | undefined;
  maxBytes?: number | undefined;
};

export type ReadLogsResult = {
  path: string;
  daemon_log_path: string;
  entries: LogEntry[];
  total: number;
};

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const COLORS: Record<LogLevel, string> = {
  debug: "\x1b[36m",
  info: "\x1b[32m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";

let currentLevel: LogLevel = (process.env.ORC_LOG_LEVEL as LogLevel | undefined) ?? "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ROTATED_FILES = 3;
const DEFAULT_READ_MAX_BYTES = 256 * 1024;

let logDir: string | null = null;
let logFilePath: string | null = null;
let fileFailed = false;

// bun test sets NODE_ENV=test; tests must not write into the user's real orc.log.
function fileEnabled(): boolean {
  const flag = process.env.ORC_LOG_FILE;
  return !fileFailed && (flag === "1" || (flag !== "0" && process.env.NODE_ENV !== "test"));
}

function resolveLogDir(): string {
  return join(process.env.ORC_LOG_DIR ?? orcHome(), "logs");
}

export function getLogFilePath(): string {
  return join(resolveLogDir(), "orc.log");
}

export function getDaemonLogPath(): string {
  return join(orcHome(), "daemon.log");
}

function activeLogFilePath(): string | null {
  const expectedDir = resolveLogDir();
  if (logDir !== expectedDir) {
    logDir = null;
    logFilePath = null;
    fileFailed = false;
  }
  if (!fileEnabled()) return null;
  if (logFilePath && existsSync(expectedDir)) return logFilePath;
  try {
    logDir = expectedDir;
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    logFilePath = join(logDir, "orc.log");
    return logFilePath;
  } catch {
    fileFailed = true;
    return null;
  }
}

function rotateIfNeeded(filePath: string): void {
  try {
    if (!existsSync(filePath)) return;
    const size = statSync(filePath).size;
    if (size < MAX_FILE_BYTES) return;
    for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
      const from = `${filePath}.${i}`;
      const to = `${filePath}.${i + 1}`;
      if (existsSync(from)) renameSync(from, to);
    }
    renameSync(filePath, `${filePath}.1`);
    writeFileSync(filePath, "");
  } catch {
    // rotation failure is non-fatal
  }
}

function writeToFile(line: string): void {
  const filePath = activeLogFilePath();
  if (!filePath) return;
  try {
    rotateIfNeeded(filePath);
    appendFileSync(filePath, `${line}\n`);
  } catch {
    // file write failure is non-fatal
  }
}

function safeStringify(data: unknown): string | undefined {
  if (data === undefined) return undefined;
  try {
    return JSON.stringify(data, (_key, value) => {
      if (value instanceof Error) return { message: value.message, stack: value.stack };
      return value;
    });
  } catch {
    return String(data);
  }
}

function log(level: LogLevel, ns: string, msg: string, data?: unknown): void {
  if (LEVELS[level] < LEVELS[currentLevel]) return;
  const ts = new Date().toISOString();

  const color = COLORS[level];
  const prefix = `${color}[${level.toUpperCase()}]${RESET} ${ts} [${ns}]`;
  if (data !== undefined) {
    console.error(`${prefix} ${msg}`, data);
  } else {
    console.error(`${prefix} ${msg}`);
  }

  const entry: Record<string, unknown> = { ts, level, ns, msg };
  const serialized = safeStringify(data);
  if (serialized !== undefined) entry.data = serialized;
  writeToFile(JSON.stringify(entry));
}

function readTailText(filePath: string, maxBytes: number): string {
  if (!existsSync(filePath)) return "";
  let fd: number | undefined;
  try {
    const size = statSync(filePath).size;
    if (size <= 0) return "";
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.allocUnsafe(length);
    fd = openSync(filePath, "r");
    const bytesRead = readSync(fd, buffer, 0, length, start);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      return nl >= 0 ? text.slice(nl + 1) : text;
    }
    return text;
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

const STDERR_LOG_PATTERN =
  /^\[(DEBUG|INFO|WARN|ERROR)\]\s+(\d{4}-\d{2}-\d{2}T\S+)\s+\[([^\]]+)\]\s+(.*)$/;

function parseLogLine(raw: string, source: "orc" | "daemon"): LogEntry | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as {
        ts?: unknown;
        level?: unknown;
        ns?: unknown;
        msg?: unknown;
        data?: unknown;
      };
      const level =
        parsed.level === "debug" ||
        parsed.level === "info" ||
        parsed.level === "warn" ||
        parsed.level === "error"
          ? parsed.level
          : null;
      return {
        ts: typeof parsed.ts === "string" ? parsed.ts : null,
        level,
        ns: typeof parsed.ns === "string" ? parsed.ns : null,
        msg: typeof parsed.msg === "string" ? parsed.msg : trimmed,
        ...(typeof parsed.data === "string" ? { data: parsed.data } : {}),
        source,
      };
    } catch {}
  }
  const clean = stripVTControlCharacters(trimmed);
  const matched = clean.match(STDERR_LOG_PATTERN);
  if (matched) {
    const lvl = matched[1]?.toLowerCase() as LogLevel;
    return {
      ts: matched[2] ?? null,
      level: lvl,
      ns: matched[3] ?? null,
      msg: matched[4] ?? clean,
      source,
    };
  }
  return { ts: null, level: null, ns: null, msg: clean, source };
}

export function readRecentLogs(options: ReadLogsOptions = {}): ReadLogsResult {
  const path = getLogFilePath();
  const daemonPath = getDaemonLogPath();
  const limit = Math.min(Math.max(Math.trunc(options.lines ?? 100), 1), 1000);
  const maxBytes = Math.max(options.maxBytes ?? DEFAULT_READ_MAX_BYTES, 4096);
  const source = options.source ?? "orc";
  const minLevel = options.level ? LEVELS[options.level] : null;
  const nsFilter = options.ns?.trim().toLowerCase() || null;
  const qFilter = options.q?.trim().toLowerCase() || null;

  const collected: LogEntry[] = [];
  const load = (filePath: string, kind: "orc" | "daemon") => {
    const text = readTailText(filePath, maxBytes);
    if (!text) return;
    for (const line of text.split(/\r?\n/)) {
      const entry = parseLogLine(line, kind);
      if (entry) collected.push(entry);
    }
  };
  if (source === "orc" || source === "all") load(path, "orc");
  if (source === "daemon" || source === "all") load(daemonPath, "daemon");

  if (source === "all") {
    collected.sort((a, b) => {
      if (a.ts && b.ts) return a.ts.localeCompare(b.ts);
      if (a.ts) return 1;
      if (b.ts) return -1;
      return 0;
    });
  }

  const filtered = collected.filter((entry) => {
    if (minLevel !== null && (entry.level === null || LEVELS[entry.level] < minLevel)) return false;
    if (nsFilter && !(entry.ns ?? "").toLowerCase().includes(nsFilter)) return false;
    if (qFilter) {
      const hay = `${entry.ns ?? ""} ${entry.msg} ${entry.data ?? ""}`.toLowerCase();
      if (!hay.includes(qFilter)) return false;
    }
    return true;
  });

  return {
    path,
    daemon_log_path: daemonPath,
    entries: filtered.slice(-limit),
    total: filtered.length,
  };
}

export function createLogger(ns: string) {
  return {
    debug: (msg: string, data?: unknown) => log("debug", ns, msg, data),
    info: (msg: string, data?: unknown) => log("info", ns, msg, data),
    warn: (msg: string, data?: unknown) => log("warn", ns, msg, data),
    error: (msg: string, data?: unknown) => log("error", ns, msg, data),
  };
}

export function getLogDir(): string | null {
  return logDir ?? (fileEnabled() ? resolveLogDir() : null);
}

export type Logger = ReturnType<typeof createLogger>;
