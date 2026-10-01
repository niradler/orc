import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { getTerminalManager } from "./service.js";

export interface TerminalSocketData {
  terminalId: string;
  detach?: () => void;
}

const WS_PATH = /^(?:\/api)?\/terminals\/([^/]+)\/ws$/;

const MIN_COLS = 2;
const MAX_COLS = 500;
const MIN_ROWS = 2;
const MAX_ROWS = 300;

export type ControlMessage =
  | { type: "resize"; cols: number; rows: number }
  | { type: "stop" }
  | null;

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

export function parseControl(text: string): ControlMessage {
  if (!text.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const msg = parsed as Record<string, unknown>;
  if (msg.type === "stop" && Object.keys(msg).length === 1) return { type: "stop" };
  if (
    msg.type === "resize" &&
    Object.keys(msg).length === 3 &&
    inRange(msg.cols, MIN_COLS, MAX_COLS) &&
    inRange(msg.rows, MIN_ROWS, MAX_ROWS)
  ) {
    return { type: "resize", cols: msg.cols, rows: msg.rows };
  }
  return null;
}

export function terminalSocketTarget(pathname: string): string | null {
  const match = WS_PATH.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export function handleTerminalUpgrade(
  req: Request,
  server: Server<TerminalSocketData>,
): Response | undefined | null {
  const url = new URL(req.url);
  const terminalId = terminalSocketTarget(url.pathname);
  if (!terminalId) return null;
  const ticket = url.searchParams.get("ticket");
  if (!ticket || !getTerminalManager().redeemTicket(ticket, terminalId)) {
    return new Response("Invalid or expired ticket", { status: 401 });
  }
  if (server.upgrade(req, { data: { terminalId } })) return undefined;
  return new Response("WebSocket upgrade failed", { status: 400 });
}

export const terminalWebsocket: WebSocketHandler<TerminalSocketData> = {
  maxPayloadLength: 1024 * 1024,
  open(ws: ServerWebSocket<TerminalSocketData>) {
    ws.data.detach = getTerminalManager().attach(ws.data.terminalId, {
      output: (data) => {
        ws.sendBinary(data);
      },
      exit: (code) => {
        ws.send(JSON.stringify({ type: "exit", code }));
      },
      replayed: () => {
        ws.send(JSON.stringify({ type: "replay-end" }));
      },
      close: () => {
        ws.close(1000);
      },
    });
  },
  // Keystrokes arrive as binary frames and control messages as text frames, so typed text that
  // happens to look like JSON can never be taken for a control message.
  message(ws, message) {
    const manager = getTerminalManager();
    const { terminalId } = ws.data;
    if (typeof message !== "string") {
      manager.write(terminalId, message);
      return;
    }
    const control = parseControl(message);
    if (control?.type === "resize") manager.resize(terminalId, control.cols, control.rows);
    else if (control?.type === "stop") manager.stop(terminalId);
  },
  close(ws) {
    ws.data.detach?.();
  },
};
