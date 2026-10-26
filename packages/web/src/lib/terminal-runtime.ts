import { FitAddon, Terminal as GhosttyTerminal, type ITheme, init } from "ghostty-web";
import { api, terminalSocketUrl } from "@/api/client";
import {
  clampTerminalFontSize,
  TERMINAL_FONT_SIZE_KEY,
  terminalFontSize,
} from "@/lib/terminal-font-size";
import { attachTerminalTextInput, type TerminalTextInput } from "@/lib/terminal-input";
import { isMacPlatform, resolveTerminalKey } from "@/lib/terminal-keys";
import {
  cellAt,
  createWheelSteps,
  cursorMoveKeys,
  isPlainClick,
  wheelReport,
  wheelTarget,
} from "@/lib/terminal-mouse";
import { writeTerminalOutput } from "@/lib/terminal-output";
import { createTerminalTextLayer, type TerminalTextLayer } from "@/lib/terminal-text-layer";
import { attachTerminalTouchScroll } from "@/lib/terminal-touch";

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
  /** Holds ghostty's editable root and, beside it, the selectable text over its canvas. */
  frame: HTMLDivElement;
  element: HTMLDivElement;
  textLayer: TerminalTextLayer;
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
  canvasObserver: ResizeObserver | null;
  onFontSizeChange?: (size: number) => void;
  textInput?: TerminalTextInput | null;
}

export const TERMINAL_THEME: ITheme = {
  background: "#000000",
  foreground: "#e5e5e5",
  cursor: "#c4c4c4",
  cursorAccent: "#000000",
  selectionBackground: "#343434",
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

export async function copyText(text: string): Promise<void> {
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

export function createRuntime(
  id: string,
  onFontSizeChange?: (size: number) => void,
): TerminalRuntime {
  const frame = document.createElement("div");
  frame.className = "absolute inset-0 overflow-hidden";
  frame.style.backgroundColor = TERMINAL_THEME.background ?? "";
  frame.dataset.testid = "terminal-surface";
  frame.style.touchAction = "none";
  const element = document.createElement("div");
  element.className = "absolute inset-0 overflow-hidden outline-none";
  element.style.padding = "8px";
  // iOS would otherwise answer a long press outside the text with its own callout and loupe.
  element.style.setProperty("-webkit-touch-callout", "none");
  element.style.userSelect = "none";

  const term = new GhosttyTerminal({
    fontSize: terminalFontSize(),
    fontFamily: terminalFontFamily(),
    cursorBlink: true,
    scrollback: 10_000,
    theme: TERMINAL_THEME,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // ghostty's root is editable, so a long press on it would raise the keyboard. The text sits
  // beside it instead, where the browser's own selection, handles and toolbar work.
  const textLayer = createTerminalTextLayer(term, () => element.querySelector("canvas"));
  frame.append(element, textLayer.element);

  const runtime: TerminalRuntime = {
    id,
    term,
    fit,
    frame,
    element,
    textLayer,
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
    canvasObserver: null,
    ...(onFontSizeChange ? { onFontSizeChange } : {}),
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
      if (text) void copyText(text).then(() => focusRuntime(runtime));
      if (action === "copy-and-clear") term.clearSelection();
    }
    if (action === "select-all") term.selectAll();
    return true;
  });

  // Ghostty makes its root a focusable contenteditable, and only taps on the canvas focus
  // the hidden input. A tap on the padding or the slack below the last row focused the root,
  // which opened the phone keyboard without anything typed reaching the shell.
  element.addEventListener("focus", (event) => {
    if (event.target === element) focusRuntime(runtime);
  });
  attachClickToMove(runtime, encoder);
  attachWheelInput(runtime, encoder);
  attachTextLayer(runtime);
  attachTerminalTouchScroll(
    frame,
    {
      getFontSize: () => term.options.fontSize,
      setFontSize: (size) => setRuntimeFontSize(runtime, size),
    },
    textLayer,
    (x, y) => tapRuntime(runtime, x, y),
  );
  frame.dataset.fontSize = String(term.options.fontSize);
  frame.dataset.scrollOffset = "0";
  term.onScroll((offset) => {
    frame.dataset.scrollOffset = String(offset);
  });
  onFontSizeChange?.(term.options.fontSize);

  return runtime;
}

export function focusRuntime(runtime: TerminalRuntime): void {
  const input = runtime.element.querySelector("textarea");
  (input ?? runtime.element).focus({ preventScroll: true });
}

export function setRuntimeFontSize(runtime: TerminalRuntime, value: number): void {
  const size = clampTerminalFontSize(value);
  if (runtime.disposed || runtime.term.options.fontSize === size) return;
  runtime.term.options.fontSize = size;
  runtime.frame.dataset.fontSize = String(size);
  if (runtime.opened) runtime.fit.fit();
  runtime.onFontSizeChange?.(size);
  try {
    localStorage.setItem(TERMINAL_FONT_SIZE_KEY, String(size));
  } catch {}
}

// The text layer only takes hits from touch: a mouse keeps ghostty's own selection, clicks
// and wheel. It follows output, scrolling and resizes, so a long press finds the rows on screen.
function attachTextLayer(runtime: TerminalRuntime): void {
  const { frame, term, textLayer } = runtime;
  const layer = textLayer.element;
  layer.style.pointerEvents = window.matchMedia?.("(pointer: coarse)").matches ? "auto" : "none";
  frame.addEventListener(
    "pointermove",
    (event) => {
      if (event.pointerType === "mouse") layer.style.pointerEvents = "none";
    },
    true,
  );
  frame.addEventListener(
    "pointerdown",
    (event) => {
      if (event.pointerType !== "touch" || layer.style.pointerEvents === "auto") return;
      layer.style.pointerEvents = "auto";
      textLayer.schedule();
    },
    true,
  );
  frame.addEventListener("touchstart", () => textLayer.hold(true), {
    capture: true,
    passive: true,
  });
  const release = (event: TouchEvent) => {
    if (event.touches.length === 0) textLayer.hold(false);
  };
  frame.addEventListener("touchend", release, { capture: true, passive: true });
  frame.addEventListener("touchcancel", release, { capture: true, passive: true });
  term.onScroll(() => textLayer.schedule());
  term.onResize(() => textLayer.schedule());
}

// A touch outside the text is taken over, so the browser emulates no mouse events and
// focuses nothing; a tap replays what it would have done on the canvas.
function tapRuntime(runtime: TerminalRuntime, x: number, y: number): void {
  const { element } = runtime;
  const canvas = element.querySelector("canvas");
  const box = canvas?.getBoundingClientRect();
  const onCanvas = box && x >= box.left && x < box.right && y >= box.top && y < box.bottom;
  const target = canvas && onCanvas ? canvas : element;
  for (const type of ["mousedown", "mouseup", "click"])
    target.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
        buttons: type === "mousedown" ? 1 : 0,
        detail: 1,
        view: window,
      }),
    );
  focusRuntime(runtime);
}

/** The active screen and its scrollback as plain text, with wrapped rows joined. */
export function runtimeText(runtime: TerminalRuntime): string {
  const buffer = runtime.term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length > 0 && !lines[lines.length - 1]?.trim()) lines.pop();
  return lines.join("\n");
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
      press = {
        x: e.clientX,
        y: e.clientY,
        wasFocused: element.contains(document.activeElement),
      };
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

const DEC_SGR_MOUSE = 1006;
const DEC_ALTERNATE_SCROLL = 1007;

// ghostty-web never reports the wheel to a program and, in a full-screen one, sends
// round(deltaY / 33) arrow keys per event. Codex tracks the mouse and reads arrows as prompt
// history, and a touch swipe moves a few pixels per event, which rounded to no keys at all.
function attachWheelInput(runtime: TerminalRuntime, encoder: TextEncoder): void {
  const { element, term } = runtime;
  const steps = createWheelSteps();
  term.attachCustomWheelEventHandler((event) => {
    const target = wheelTarget({
      mouseTracking: term.hasMouseTracking(),
      alternateScreen: term.buffer.active.type === "alternate",
      alternateScroll: term.getMode(DEC_ALTERNATE_SCROLL),
    });
    if (target === "scrollback") return false;
    const count = steps(event.deltaY, event.deltaMode, term.rows);
    const socket = runtime.socket;
    if (count === 0 || !socket || socket.readyState !== WebSocket.OPEN) return true;
    let step: string;
    if (target === "arrows") {
      step = `\x1b${term.getMode(DEC_APPLICATION_CURSOR) ? "O" : "["}${count < 0 ? "A" : "B"}`;
    } else {
      const box = element.querySelector("canvas")?.getBoundingClientRect();
      // A wheel over the padding still belongs to the nearest cell.
      const cell = box
        ? cellAt(
            {
              left: box.left,
              top: box.top,
              width: box.width,
              height: box.height,
              cols: term.cols,
              rows: term.rows,
            },
            Math.min(Math.max(event.clientX, box.left), box.right - 1),
            Math.min(Math.max(event.clientY, box.top), box.bottom - 1),
          )
        : null;
      step = wheelReport(count < 0, cell ?? { col: 0, row: 0 }, term.getMode(DEC_SGR_MOUSE));
    }
    if (step) socket.send(encoder.encode(step.repeat(Math.abs(count))));
    return true;
  });
}

// Ghostty redraws every opened terminal on every animation frame, visible or not. Keeping
// one loop per terminal ever opened saturated phone CPUs and delayed typed output, so the
// loop only runs while the terminal is in the page. Output written meanwhile stays dirty
// in the VT buffer and is drawn when the loop resumes.
interface RenderLoop {
  animationFrameId?: number;
  startRenderLoop?: () => void;
}

function pauseRendering(term: GhosttyTerminal): void {
  const loop = term as unknown as RenderLoop;
  if (loop.animationFrameId !== undefined) cancelAnimationFrame(loop.animationFrameId);
  loop.animationFrameId = undefined;
}

function resumeRendering(term: GhosttyTerminal): void {
  const loop = term as unknown as RenderLoop;
  if (loop.animationFrameId === undefined) loop.startRenderLoop?.();
}

export function mountRuntime(runtime: TerminalRuntime, container: HTMLElement, focus = true): void {
  const focusedBeforeMount = document.activeElement;
  const shouldFocus =
    focus && !focusedBeforeMount?.closest('[role="dialog"], [data-radix-popper-content-wrapper]');
  container.appendChild(runtime.frame);
  if (!runtime.opened) {
    // Ghostty's focus() schedules a second, unguarded focus. Startup owns focus below
    // so opening a menu immediately after mount cannot be interrupted by that timer.
    const originalFocus = runtime.term.focus;
    runtime.term.focus = () => {};
    try {
      runtime.term.open(runtime.element);
      runtime.textInput = attachTerminalTextInput(runtime.element, (data) =>
        runtime.term.input(data, true),
      );
    } finally {
      runtime.term.focus = originalFocus;
    }
    runtime.fit.observeResize();
    const canvas = runtime.element.querySelector("canvas");
    if (canvas) {
      runtime.canvasObserver = new ResizeObserver(() => runtime.textLayer.schedule());
      runtime.canvasObserver.observe(canvas);
    }
    runtime.opened = true;
  } else {
    resumeRendering(runtime.term);
  }
  requestAnimationFrame(() => {
    if (runtime.disposed || runtime.frame.parentElement !== container) return;
    runtime.fit.fit();
    runtime.textLayer.sync();
    // Loading the renderer must not dismiss a menu or interrupt a newer interaction.
    if (shouldFocus && document.activeElement === focusedBeforeMount) focusRuntime(runtime);
  });
}

export function unmountRuntime(runtime: TerminalRuntime): void {
  runtime.frame.remove();
  if (runtime.opened) pauseRendering(runtime.term);
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
        writeTerminalOutput(runtime.term, new Uint8Array(event.data));
      } finally {
        runtime.muteReplies = false;
      }
      runtime.textLayer.schedule();
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
  runtime.canvasObserver?.disconnect();
  runtime.canvasObserver = null;
  runtime.fit.dispose();
  runtime.term.dispose();
  runtime.textLayer.dispose();
  runtime.frame.remove();
}
