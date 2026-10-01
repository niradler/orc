import { ConflictError, NotFoundError } from "@orc/core/errors";
import { ulid } from "@orc/core/ids";
import type { Launch, LaunchKind } from "./launch.js";
import type { PtyHandle, SpawnPty } from "./spawn.js";

export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 32;
export const TICKET_TTL_SECONDS = 30;
const MAX_EXITED_KEPT = 16;

export type TerminalStatus = "running" | "exited";

export interface TerminalInfo {
  id: string;
  name: string;
  kind: LaunchKind;
  cwd: string | null;
  status: TerminalStatus;
  exit_code: number | null;
  pid: number | null;
  live_session_id: string | null;
  created_at: string;
}

export interface TerminalSink {
  output(data: Uint8Array): void;
  exit(code: number | null): void;
}

export interface CreateTerminalInput {
  launch: Launch;
  name?: string | undefined;
  liveSessionId?: string | null | undefined;
}

export interface TerminalManagerOptions {
  spawn: SpawnPty;
  env: Record<string, string | undefined>;
  max: number;
  scrollbackBytes: number;
  now?: (() => number) | undefined;
}

interface Entry {
  info: TerminalInfo;
  pty: PtyHandle;
  sinks: Set<TerminalSink>;
  scrollback: Uint8Array[];
  scrollbackSize: number;
}

interface Ticket {
  terminalId: string;
  expiresAt: number;
}

function ptyEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  out.TERM = "xterm-256color";
  out.COLORTERM = "truecolor";
  return out;
}

function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
}

export class TerminalManager {
  private readonly entries = new Map<string, Entry>();
  private readonly tickets = new Map<string, Ticket>();
  private readonly now: () => number;

  constructor(private readonly options: TerminalManagerOptions) {
    this.now = options.now ?? Date.now;
  }

  list(): TerminalInfo[] {
    return [...this.entries.values()].map((e) => ({ ...e.info }));
  }

  get(id: string): TerminalInfo {
    return { ...this.entry(id).info };
  }

  findByLiveSession(liveSessionId: string): TerminalInfo | null {
    for (const e of this.entries.values()) {
      if (e.info.live_session_id === liveSessionId && e.info.status === "running") {
        return { ...e.info };
      }
    }
    return null;
  }

  create(input: CreateTerminalInput): TerminalInfo {
    const running = [...this.entries.values()].filter((e) => e.info.status === "running").length;
    if (running >= this.options.max) {
      throw new ConflictError(`Terminal limit reached (${this.options.max})`);
    }
    this.pruneExited();
    const id = ulid();
    const sinks = new Set<TerminalSink>();
    const entry: Entry = {
      info: {
        id,
        name: input.name?.trim() || defaultName(input),
        kind: input.launch.kind,
        cwd: input.launch.cwd ?? null,
        status: "running",
        exit_code: null,
        pid: null,
        live_session_id: input.liveSessionId ?? null,
        created_at: new Date(this.now()).toISOString(),
      },
      pty: undefined as unknown as PtyHandle,
      sinks,
      scrollback: [],
      scrollbackSize: 0,
    };
    entry.pty = this.options.spawn(input.launch.argv, {
      cwd: input.launch.cwd,
      env: ptyEnv(this.options.env),
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      onData: (data) => this.onData(entry, data),
    });
    entry.info.pid = entry.pty.pid;
    this.entries.set(id, entry);
    entry.pty.exited.then((code) => this.onExit(entry, code));
    return { ...entry.info };
  }

  attach(id: string, sink: TerminalSink): () => void {
    const entry = this.entry(id);
    for (const chunk of entry.scrollback) sink.output(chunk);
    if (entry.info.status === "exited") sink.exit(entry.info.exit_code);
    entry.sinks.add(sink);
    return () => {
      entry.sinks.delete(sink);
    };
  }

  write(id: string, data: string | Uint8Array): void {
    const entry = this.entries.get(id);
    if (entry?.info.status === "running") entry.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const entry = this.entries.get(id);
    if (entry?.info.status === "running") entry.pty.resize(cols, rows);
  }

  stop(id: string): TerminalInfo {
    const entry = this.entry(id);
    if (entry.info.status === "running") entry.pty.kill();
    return { ...entry.info };
  }

  remove(id: string): void {
    const entry = this.entry(id);
    if (entry.info.status === "running") entry.pty.kill();
    entry.sinks.clear();
    this.entries.delete(id);
    for (const [token, t] of this.tickets) if (t.terminalId === id) this.tickets.delete(token);
  }

  mintTicket(id: string): { ticket: string; expires_in: number } {
    this.entry(id);
    const now = this.now();
    for (const [token, t] of this.tickets) if (t.expiresAt <= now) this.tickets.delete(token);
    const ticket = randomToken();
    this.tickets.set(ticket, {
      terminalId: id,
      expiresAt: now + TICKET_TTL_SECONDS * 1000,
    });
    return { ticket, expires_in: TICKET_TTL_SECONDS };
  }

  redeemTicket(ticket: string, id: string): boolean {
    const t = this.tickets.get(ticket);
    if (!t) return false;
    this.tickets.delete(ticket);
    return t.terminalId === id && t.expiresAt > this.now() && this.entries.has(id);
  }

  shutdown(): void {
    for (const entry of this.entries.values()) {
      if (entry.info.status === "running") entry.pty.kill();
    }
    this.entries.clear();
    this.tickets.clear();
  }

  private entry(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new NotFoundError("Terminal", id);
    return entry;
  }

  private onData(entry: Entry, data: Uint8Array): void {
    const chunk = data.slice();
    entry.scrollback.push(chunk);
    entry.scrollbackSize += chunk.length;
    while (entry.scrollbackSize > this.options.scrollbackBytes && entry.scrollback.length > 1) {
      const dropped = entry.scrollback.shift();
      entry.scrollbackSize -= dropped?.length ?? 0;
    }
    for (const sink of entry.sinks) sink.output(chunk);
  }

  private onExit(entry: Entry, code: number | null): void {
    if (entry.info.status === "exited") return;
    entry.info.status = "exited";
    entry.info.exit_code = code;
    for (const sink of entry.sinks) sink.exit(code);
  }

  private pruneExited(): void {
    const exited = [...this.entries.values()].filter((e) => e.info.status === "exited");
    for (const e of exited.slice(0, Math.max(0, exited.length - MAX_EXITED_KEPT))) {
      this.entries.delete(e.info.id);
    }
  }
}

function defaultName(input: CreateTerminalInput): string {
  const { launch } = input;
  const tail = launch.cwd?.split(/[\\/]/).filter(Boolean).pop();
  const label = launch.resume ? `${launch.kind} (resume)` : launch.kind;
  return tail ? `${label} · ${tail}` : label;
}
