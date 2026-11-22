import type { BuddyTransport } from "../bridge.js";
import { type BuddyCommand, type BuddySnapshot, BuddySnapshotSchema } from "../protocol.js";

const FACES: Record<string, string> = {
  idle: "(o_o)",
  busy: "(o_o;)",
  attention: "(!o!)",
  celebrate: "\\(^o^)/",
  error: "(x_x)",
  sleep: "(-_-)",
};

type SimStreams = {
  output?: NodeJS.WriteStream;
  input?: NodeJS.ReadStream;
};

/**
 * Renders snapshots as a terminal screen and turns keypresses into the same
 * commands the firmware sends, so the whole bridge path works without hardware.
 */
export function createSimulatorTransport(streams: SimStreams = {}): BuddyTransport {
  const output = streams.output ?? process.stdout;
  const input = streams.input ?? process.stdin;
  const messageHandlers: ((value: unknown) => void)[] = [];
  const closeHandlers: (() => void)[] = [];
  let snapshot: BuddySnapshot | null = null;
  let selected = 0;
  let closed = false;
  let lastAck = "";
  const rawMode = Boolean(input.isTTY && typeof input.setRawMode === "function");

  const width = () => Math.max(40, output.columns ?? 80);
  const clip = (line: string) => (line.length <= width() ? line : `${line.slice(0, width() - 1)}…`);

  function render(): void {
    const lines: string[] = [];
    const face = snapshot ? (FACES[snapshot.mood] ?? FACES.idle) : FACES.sleep;
    const mood = snapshot?.mood ?? "sleep";
    const counts = snapshot
      ? `${snapshot.sessions.total} sessions · ${snapshot.sessions.working} working · ${snapshot.sessions.waiting} waiting`
      : "no link";
    lines.push(clip(`  ${face}  ${mood.toUpperCase()}   ${counts}`));
    if (snapshot) {
      const tokens =
        snapshot.tokens_today === null
          ? ""
          : `   tokens today: ${snapshot.tokens_today.toLocaleString()}`;
      lines.push(clip(`  unread: ${snapshot.unread}${tokens}`));
      const actionable = snapshot.needs_you.filter((item) => item.actionable);
      if (snapshot.needs_you.length) {
        lines.push("  NEEDS YOU");
        snapshot.needs_you.slice(0, 5).forEach((item) => {
          const actionableIndex = actionable.indexOf(item);
          const isSelected =
            item.actionable && actionableIndex === selected % Math.max(1, actionable.length);
          const marker = isSelected ? ">" : " ";
          const tag = item.actionable ? item.kind : `${item.kind} · view only`;
          lines.push(
            clip(`  ${marker} [${tag}] ${item.title}${item.project ? ` (${item.project})` : ""}`),
          );
          if (item.hint) lines.push(clip(`      ${item.hint}`));
          if (item.choices?.length && isSelected)
            lines.push(clip(`      choices: ${item.choices.join(" | ")}`));
        });
      }
      if (snapshot.recent.length) {
        lines.push("  RECENT");
        for (const item of snapshot.recent)
          lines.push(clip(`  ${item.unread ? "*" : " "} ${item.line}`));
      }
    }
    if (lastAck) lines.push(clip(`  ${lastAck}`));
    lines.push(clip("  keys: [n]ext  [a]pprove/answer  [d]eny  [r]ead  [q]uit"));
    output.write(`\x1b[2J\x1b[H${lines.join("\n")}\n`);
  }

  function emit(command: BuddyCommand): void {
    for (const handler of messageHandlers) handler(command);
  }

  function selectedActionable() {
    const actionable = snapshot?.needs_you.filter((item) => item.actionable) ?? [];
    if (!actionable.length) return null;
    return actionable[selected % actionable.length];
  }

  function onKey(data: Buffer): void {
    const key = data.toString("utf8").toLowerCase();
    if (key === "q" || key === "\u0003") {
      void close();
      return;
    }
    if (!snapshot) return;
    if (key === "n") {
      selected += 1;
      render();
    } else if (key === "a") {
      const item = selectedActionable();
      if (!item) return;
      if (item.kind === "approval") emit({ cmd: "respond", id: item.id, decision: "approve" });
      else if (item.kind === "question" && item.choices?.length) {
        const choice = item.choices[0];
        if (choice) emit({ cmd: "answer", id: item.id, choice });
      }
    } else if (key === "d") {
      const item = selectedActionable();
      if (item?.kind === "approval") emit({ cmd: "respond", id: item.id, decision: "deny" });
    } else if (key === "r") {
      const unread = snapshot.recent.find((item) => item.unread);
      if (unread) emit({ cmd: "read", id: unread.id });
    }
  }

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    input.removeListener("data", onKey);
    if (rawMode) input.setRawMode?.(false);
    input.pause();
    output.write("\x1b[2J\x1b[Hbuddy simulator stopped\n");
    for (const handler of closeHandlers) handler();
  }

  if (rawMode) input.setRawMode?.(true);
  input.resume();
  input.on("data", onKey);
  render();

  return {
    label: "simulator",
    send(line) {
      if (closed) return;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return;
      }
      const parsed = BuddySnapshotSchema.safeParse(value);
      if (parsed.success) {
        snapshot = parsed.data;
        lastAck = "";
        render();
        return;
      }
      const ack = value as { ack?: string; ok?: boolean; error?: string };
      if (typeof ack.ack === "string") {
        lastAck = `ack ${ack.ack}: ${ack.ok ? "ok" : (ack.error ?? "failed")}`;
        render();
      }
    },
    onMessage(handler) {
      messageHandlers.push(handler);
    },
    onClose(handler) {
      closeHandlers.push(handler);
    },
    close,
  };
}
