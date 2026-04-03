import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

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

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_ROTATED_FILES = 3;

let logDir: string | null = null;
let logFilePath: string | null = null;
let fileEnabled = process.env.ORC_LOG_FILE !== "0";

function getLogFilePath(): string | null {
  if (!fileEnabled) return null;
  if (logFilePath) return logFilePath;
  try {
    logDir = join(process.env.ORC_LOG_DIR ?? join(homedir(), ".orc"), "logs");
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    logFilePath = join(logDir, "orc.log");
    return logFilePath;
  } catch {
    fileEnabled = false;
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
  const filePath = getLogFilePath();
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

  // stderr (human-readable, colored)
  const color = COLORS[level];
  const prefix = `${color}[${level.toUpperCase()}]${RESET} ${ts} [${ns}]`;
  if (data !== undefined) {
    console.error(`${prefix} ${msg}`, data);
  } else {
    console.error(`${prefix} ${msg}`);
  }

  // file (JSON lines, machine-readable)
  const entry: Record<string, unknown> = { ts, level, ns, msg };
  const serialized = safeStringify(data);
  if (serialized !== undefined) entry.data = serialized;
  writeToFile(JSON.stringify(entry));
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
  return logDir;
}

export type Logger = ReturnType<typeof createLogger>;
