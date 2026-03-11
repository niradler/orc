export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const COLORS: Record<LogLevel, string> = {
  debug: "\x1b[36m",
  info: "\x1b[32m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";

let currentLevel: LogLevel = (process.env["ORC_LOG_LEVEL"] as LogLevel | undefined) ?? "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
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
}

export function createLogger(ns: string) {
  return {
    debug: (msg: string, data?: unknown) => log("debug", ns, msg, data),
    info: (msg: string, data?: unknown) => log("info", ns, msg, data),
    warn: (msg: string, data?: unknown) => log("warn", ns, msg, data),
    error: (msg: string, data?: unknown) => log("error", ns, msg, data),
  };
}

export type Logger = ReturnType<typeof createLogger>;
