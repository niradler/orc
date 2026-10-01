import { FitAddon, Terminal as GhosttyTerminal, type ITheme, init } from "ghostty-web";
import { api, terminalSocketUrl } from "@/api/client";
import { isMacPlatform, resolveTerminalKey } from "@/lib/terminal-keys";
import { cellAt, cursorMoveKeys, isPlainClick } from "@/lib/terminal-mouse";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "exited" | "closed";

export interface RuntimeCallbacks {
  onState: (id: string, state: ConnectionState) => void;
  onExit: (id: string) => void;
  shouldRetry: (id: string, attempts: number) => boolean;
}

export interface TerminalRuntime {
  id: string;
  term: GhosttyTerminal;
  fit: FitAddon;
  element: HTMLDivElement;
  socket: WebSocket | null;
  opened: boolean;
  connecting: boolean;
  everConnected: boolean;
  exitSeen: boolean;
  disposed: boolean;
  /** The server is still replaying scrollback; the terminal's replies to it are history, not input. */
  replaying: boolean;
  /** Set around a synchronous `term.write` of replayed data so ghostty's replies are dropped. */
  muteReplies: boolean;
  attempts: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  resizeTimer: ReturnType<typeof setTimeout> | null;
}

export const TERMINAL_THEME: ITheme = {
  background: "#090e1a",
  foreground: "#e1e5f6",
  cursor: "#78b0ff",
  cursorAccent: "#090e1a",
  selectionBackground: "#2c3a5a",
  black: "#1e2537",
  red: "#ff716c",
  green: "#70fda7",
  yellow: "#ffa851",
  blue: "#78b0ff",
  magenta: "#c79bff",
  cyan: "#5ee3f0",
  white: "#a6abbb",
  brightBlack: "#434856",
  brightRed: "#ff8f8b",
  brightGreen: "#8affbd",
  brightYellow: "#ffc07a",
  brightBlue: "#9cc4ff",
  brightMagenta: "#ddb8ff",
  brightCyan: "#8df0f8",
  brightWhite: "#ffffff",
};

// Prompts and agent status lines (starship, oh-my-posh, Claude Code) draw icons from the
// Private Use Area. Only a Nerd Font has them, so the common installed names come first.
const DEFAULT_FONT_FAMILY = [
  "'JetBrainsMono Nerd Font Mono'",
  "'JetBrainsMono NFM'",
  "'CaskaydiaCove Nerd Font Mono'",
  "'CaskaydiaCove NFM'",
  "'Cascadia Mono NF'",
  "'Cascadia Code NF'",
  "'FiraCode Nerd Font Mono'",
  "'Hack Nerd Font Mono'",
  "'MesloLGS NF'",
  "'MesloLGM Nerd Font Mono'",
  "'Symbols Nerd Font Mono'",
  "'JetBrains Mono'",
  "'Cascadia Mono'",
  "Menlo",
  "Consolas",
  "'DejaVu Sans Mono'",
  "monospace",
].join(", ");
export const TERMINAL_FONT_KEY = "orc_terminal_font";
const MAX_BACKOFF_MS = 10_000;
// Dragging the side panel fires a fit per frame; a TUI redrawing for every one of them
// interleaves with typed input, so only the settled size is sent.
const RESIZE_SETTLE_MS = 120;

export function terminalFontFamily(): string {
  let custom = "";
  try {
    custom = localStorage.getItem(TERMINAL_FONT_KEY)?.trim() ?? "";
  } catch {}
  if (!custom) return DEFAULT_FONT_FAMILY;
  const quoted = custom.includes(",") || /^['"]/.test(custom) ? custom : `'${custom}'`;
  return `${quoted}, ${DEFAULT_FONT_FAMILY}`;
}

let ghosttyReady: Promise<void> | null = null;

export function loadGhostty(): Promise<void> {
  if (!ghosttyReady) {
    ghosttyReady = init().catch((error: unknown) => {
      ghosttyReady = null;
      throw error;
    });
  }
  return ghosttyReady;
}

async function copyText(text: string): Promise<void> {
  const written = await navigator.clipboard?.writeText(text).then(
    () => true,
    () => false,
  );
  if (written) return;
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

function sendResize(runtime: TerminalRuntime): void {
  if (runtime.resizeTimer) clearTimeout(runtime.resizeTimer);
  runtime.resizeTimer = null;
  const socket = runtime.socket;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const cols = Math.min(500, Math.max(2, runtime.term.cols));
  const rows = Math.min(300, Math.max(2, runtime.term.rows));
  socket.send(JSON.stringify({ type: "resize", cols, rows }));
}

function scheduleResize(runtime: TerminalRuntime): void {
  if (runtime.resizeTimer) clearTimeout(runtime.resizeTimer);
  runtime.resizeTimer = setTimeout(() => sendResize(runtime), RESIZE_SETTLE_MS);
}

export function createRuntime(id: string): TerminalRuntime {
  const element = document.createElement("div");
  element.className = "absolute inset-0 overflow-hidden outline-none";
  element.style.padding = "8px";
  element.style.backgroundColor = TERMINAL_THEME.background ?? "";

  const term = new GhosttyTerminal({
    fontSize: 13,
    fontFamily: terminalFontFamily(),
    cursorBlink: true,
    scrollback: 10_000,
    theme: TERMINAL_THEME,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  const runtime: TerminalRuntime = {
    id,
    term,
    fit,
    element,
    socket: null,
    opened: false,
    connecting: false,
    everConnected: false,
    exitSeen: false,
    disposed: false,
    replaying: false,
    muteReplies: false,
    attempts: 0,
    retryTimer: null,
    resizeTimer: null,
  };

  // Keystrokes go out as binary frames; text frames are reserved for control messages.
  const encoder = new TextEncoder();
  term.onData((data) => {
    if (runtime.muteReplies) return;
    const socket = runtime.socket;
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
  });
  term.onResize(() => scheduleResize(runtime));

  const mac = isMacPlatform();
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown") return false;
    const action = resolveTerminalKey(event, mac, term.hasSelection());
    if (action === "pass") return false;
    if (action === "copy" || action === "copy-and-clear") {
      const text = term.getSelection();
      if (text) void copyText(text).then(() => term.focus());
      if (action === "copy-and-clear") term.clearSelection();
    }
    if (action === "select-all") term.selectAll();
    return true;
  });

  attachClickToMove(runtime, encoder);

  return runtime;
}

// Application cursor keys (DECCKM) change the arrow sequences a shell expects.
const DEC_APPLICATION_CURSOR = 1;
const CLICK_SLOP_PX = 4;

function attachClickToMove(runtime: TerminalRuntime, encoder: TextEncoder): void {
  const { element, term } = runtime;
  let press: { x: number; y: number; wasFocused: boolean } | null = null;

  element.addEventListener(
    "mousedown",
    (e) => {
      press = { x: e.clientX, y: e.clientY, wasFocused: element.contains(document.activeElement) };
    },
    true,
  );
  element.addEventListener("mouseup", (e) => {
    const start = press;
    press = null;
    const canvas = element.querySelector("canvas");
    const socket = runtime.socket;
    if (!start || !canvas || !socket || socket.readyState !== WebSocket.OPEN) return;
    const dragged = Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK_SLOP_PX;
    const plain = isPlainClick({
      alternateScreen: term.buffer.active.type === "alternate",
      scrolledBack: term.viewportY > 0,
      hasSelection: term.hasSelection(),
      wasFocused: start.wasFocused,
      button: e.button,
      detail: e.detail,
      modified: e.shiftKey || e.ctrlKey || e.altKey || e.metaKey,
      dragged,
    });
    if (!plain) return;
    const box = canvas.getBoundingClientRect();
    const cell = cellAt(
      {
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        cols: term.cols,
        rows: term.rows,
      },
      e.clientX,
      e.clientY,
    );
    const cursor = term.buffer.active;
    if (!cell || cell.row !== cursor.cursorY) return;
    const keys = cursorMoveKeys(cursor.cursorX, cell.col, term.getMode(DEC_APPLICATION_CURSOR));
    if (keys) socket.send(encoder.encode(keys));
  });
}

export function mountRuntime(runtime: TerminalRuntime, container: HTMLElement): void {
  container.appendChild(runtime.element);
  if (!runtime.opened) {
    runtime.term.open(runtime.element);
    runtime.fit.observeResize();
    runtime.opened = true;
  }
  requestAnimationFrame(() => {
    if (runtime.disposed || runtime.element.parentElement !== container) return;
    runtime.fit.fit();
    runtime.term.focus();
  });
}

export function unmountRuntime(runtime: TerminalRuntime): void {
  runtime.element.remove();
}

function scheduleReconnect(runtime: TerminalRuntime, callbacks: RuntimeCallbacks): void {
  if (runtime.disposed || runtime.retryTimer) return;
  if (!callbacks.shouldRetry(runtime.id, runtime.attempts)) {
    callbacks.onState(runtime.id, "closed");
    return;
  }
  const delay = Math.min(1000 * 2 ** runtime.attempts, MAX_BACKOFF_MS);
  runtime.attempts += 1;
  callbacks.onState(runtime.id, "reconnecting");
  runtime.retryTimer = setTimeout(() => {
    runtime.retryTimer = null;
    void connectRuntime(runtime, callbacks);
  }, delay);
}

export async function connectRuntime(
  runtime: TerminalRuntime,
  callbacks: RuntimeCallbacks,
): Promise<void> {
  if (runtime.disposed || runtime.connecting || runtime.socket || runtime.exitSeen) return;
  if (runtime.retryTimer) {
    clearTimeout(runtime.retryTimer);
    runtime.retryTimer = null;
  }
  runtime.connecting = true;
  callbacks.onState(runtime.id, runtime.everConnected ? "reconnecting" : "connecting");

  let url: string;
  try {
    const { ticket } = await api.terminals.ticket(runtime.id);
    url = terminalSocketUrl(runtime.id, ticket);
  } catch {
    runtime.connecting = false;
    scheduleReconnect(runtime, callbacks);
    return;
  }
  runtime.connecting = false;
  if (runtime.disposed) return;

  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  runtime.socket = socket;

  socket.onopen = () => {
    runtime.attempts = 0;
    runtime.replaying = true;
    if (runtime.everConnected) runtime.term.reset();
    runtime.everConnected = true;
    callbacks.onState(runtime.id, "connected");
    sendResize(runtime);
  };

  socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
    if (runtime.disposed) return;
    if (typeof event.data !== "string") {
      // ghostty answers queries in the data (cursor position, device attributes) synchronously
      // inside write(). Replayed history was already answered when it was first produced, so
      // those answers would reach the shell as stray keystrokes.
      runtime.muteReplies = runtime.replaying;
      try {
        runtime.term.write(new Uint8Array(event.data));
      } finally {
        runtime.muteReplies = false;
      }
      return;
    }
    const control = parseControlFrame(event.data);
    if (control?.type === "replay-end") {
      runtime.replaying = false;
    } else if (control?.type === "exit") {
      runtime.exitSeen = true;
      callbacks.onState(runtime.id, "exited");
      callbacks.onExit(runtime.id);
    }
  };

  socket.onclose = () => {
    if (runtime.socket === socket) runtime.socket = null;
    if (runtime.disposed || runtime.exitSeen) return;
    scheduleReconnect(runtime, callbacks);
  };
}

function parseControlFrame(text: string): { type?: string } | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as { type?: string }) : null;
  } catch {
    return null;
  }
}

export function disposeRuntime(runtime: TerminalRuntime): void {
  runtime.disposed = true;
  if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
  runtime.retryTimer = null;
  if (runtime.resizeTimer) clearTimeout(runtime.resizeTimer);
  runtime.resizeTimer = null;
  const socket = runtime.socket;
  runtime.socket = null;
  if (socket) {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.close(1000);
  }
  runtime.fit.dispose();
  runtime.term.dispose();
  runtime.element.remove();
}
