import type { Terminal } from "ghostty-web";

type OutputTerminal = Pick<Terminal, "buffer" | "viewportY" | "write" | "scrollToLine">;

export function writeTerminalOutput(term: OutputTerminal, data: Uint8Array): void {
  const viewport = term.viewportY;
  const buffer = term.buffer.active;
  const length = buffer.length;
  const preserve = buffer.type === "normal" && viewport > 0;

  term.write(data);

  // Ghostty resets the viewport on every write, including Claude's cursor redraws.
  // Its scrollToLine argument is an offset from the bottom despite the API comment.
  if (preserve && term.buffer.active.type === "normal") {
    term.scrollToLine(viewport + Math.max(0, term.buffer.active.length - length));
  }
}

/** Socket frames arrive faster than the screen refreshes; one write per frame keeps
 * VT parsing, query replies and viewport restoration from running per chunk. */
export interface OutputBuffer {
  pendingOutput: Uint8Array[];
  pendingBytes: number;
  outputFrame: number | null;
}

export interface OutputFrameScheduler {
  schedule(callback: () => void): number;
  cancel(id: number): void;
}

const defaultFrames: OutputFrameScheduler = {
  schedule: (callback) => requestAnimationFrame(callback),
  cancel: (id) => cancelAnimationFrame(id),
};

// A burst larger than this is written immediately so memory and per-write work stay bounded.
export const OUTPUT_FLUSH_BYTES = 128 * 1024;

/** Write everything queued so far as a single chunk. */
export function flushOutputBuffer(
  buffer: OutputBuffer,
  write: (data: Uint8Array) => void,
  frames: OutputFrameScheduler = defaultFrames,
): void {
  if (buffer.outputFrame !== null) {
    frames.cancel(buffer.outputFrame);
    buffer.outputFrame = null;
  }
  const chunks = buffer.pendingOutput;
  if (chunks.length === 0) return;
  const total = buffer.pendingBytes;
  buffer.pendingOutput = [];
  buffer.pendingBytes = 0;
  let data = chunks[0];
  if (chunks.length > 1) {
    data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
  }
  write(data);
}

/** Queue a socket chunk for the next frame, flushing early once the burst grows large. */
export function queueOutputChunk(
  buffer: OutputBuffer,
  chunk: Uint8Array,
  write: (data: Uint8Array) => void,
  frames: OutputFrameScheduler = defaultFrames,
  flushBytes: number = OUTPUT_FLUSH_BYTES,
): void {
  buffer.pendingOutput.push(chunk);
  buffer.pendingBytes += chunk.length;
  if (buffer.pendingBytes >= flushBytes) {
    flushOutputBuffer(buffer, write, frames);
    return;
  }
  if (buffer.outputFrame === null) {
    buffer.outputFrame = frames.schedule(() => {
      buffer.outputFrame = null;
      flushOutputBuffer(buffer, write, frames);
    });
  }
}

/** Drop queued chunks without writing them; a reconnect replays scrollback instead. */
export function clearOutputBuffer(
  buffer: OutputBuffer,
  frames: OutputFrameScheduler = defaultFrames,
): void {
  if (buffer.outputFrame !== null) frames.cancel(buffer.outputFrame);
  buffer.outputFrame = null;
  buffer.pendingOutput = [];
  buffer.pendingBytes = 0;
}
