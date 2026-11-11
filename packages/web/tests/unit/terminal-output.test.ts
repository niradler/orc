import { expect, test } from "bun:test";
import {
  clearOutputBuffer,
  flushOutputBuffer,
  type OutputBuffer,
  type OutputFrameScheduler,
  queueOutputChunk,
  writeTerminalOutput,
} from "../../src/lib/terminal-output";

function terminal(viewport: number, type: "normal" | "alternate" = "normal", growth = 0) {
  const term = {
    viewportY: viewport,
    buffer: { active: { type, length: 200 } },
    restored: [] as number[],
    write(_data: Uint8Array): void {
      term.viewportY = 0;
      term.buffer.active.length += growth;
    },
    scrollToLine(line: number): void {
      term.viewportY = line;
      term.restored.push(line);
    },
  };
  return term;
}

test("should preserve scrollback during Claude redraws", () => {
  const term = terminal(30.5);
  writeTerminalOutput(term, new Uint8Array());
  expect(term.viewportY).toBe(30.5);
});

test("should keep the same history visible when new lines arrive", () => {
  const term = terminal(30, "normal", 3);
  writeTerminalOutput(term, new Uint8Array());
  expect(term.viewportY).toBe(33);
});

test("should follow output at the bottom and leave alternate screens alone", () => {
  for (const term of [terminal(0), terminal(30, "alternate")]) {
    writeTerminalOutput(term, new Uint8Array());
    expect(term.restored).toEqual([]);
  }
});

function fakeFrames() {
  const scheduled = new Map<number, () => void>();
  let nextId = 1;
  const cancelled: number[] = [];
  const state = { hidden: false };
  const frames: OutputFrameScheduler = {
    paused: () => state.hidden,
    schedule(callback) {
      const id = nextId++;
      scheduled.set(id, callback);
      return id;
    },
    cancel(id) {
      cancelled.push(id);
      scheduled.delete(id);
    },
  };
  return {
    frames,
    cancelled,
    state,
    fire() {
      const pending = [...scheduled.entries()];
      scheduled.clear();
      for (const [, callback] of pending) callback();
    },
    get size() {
      return scheduled.size;
    },
  };
}

function buffer(): OutputBuffer {
  return { pendingOutput: [], pendingBytes: 0, outputFrame: null };
}

const bytes = (...values: number[]) => new Uint8Array(values);

test("coalesces a frame's chunks into one ordered write", () => {
  const out = buffer();
  const clock = fakeFrames();
  const writes: Uint8Array[] = [];
  const write = (data: Uint8Array) => writes.push(data);
  queueOutputChunk(out, bytes(1, 2), write, clock.frames);
  queueOutputChunk(out, bytes(3), write, clock.frames);
  queueOutputChunk(out, bytes(4, 5, 6), write, clock.frames);
  expect(writes.length).toBe(0);
  expect(clock.size).toBe(1);
  clock.fire();
  expect(writes.length).toBe(1);
  expect([...writes[0]]).toEqual([1, 2, 3, 4, 5, 6]);
  expect(out.pendingBytes).toBe(0);
  expect(out.outputFrame).toBeNull();
});

test("a lone chunk is written without copying", () => {
  const out = buffer();
  const clock = fakeFrames();
  const writes: Uint8Array[] = [];
  const chunk = bytes(9, 9);
  queueOutputChunk(out, chunk, (data) => writes.push(data), clock.frames);
  clock.fire();
  expect(writes[0]).toBe(chunk);
});

test("a large burst flushes immediately instead of waiting for the frame", () => {
  const out = buffer();
  const clock = fakeFrames();
  const writes: Uint8Array[] = [];
  const write = (data: Uint8Array) => writes.push(data);
  queueOutputChunk(out, bytes(1), write, clock.frames, 4);
  expect(writes.length).toBe(0);
  queueOutputChunk(out, bytes(2, 3, 4), write, clock.frames, 4);
  expect(writes.length).toBe(1);
  expect([...writes[0]]).toEqual([1, 2, 3, 4]);
  expect(clock.size).toBe(0);
  expect(out.pendingBytes).toBe(0);
});

test("explicit flush writes once and cancels the scheduled frame", () => {
  const out = buffer();
  const clock = fakeFrames();
  const writes: Uint8Array[] = [];
  const write = (data: Uint8Array) => writes.push(data);
  queueOutputChunk(out, bytes(1), write, clock.frames);
  queueOutputChunk(out, bytes(2), write, clock.frames);
  flushOutputBuffer(out, write, clock.frames);
  expect(writes.length).toBe(1);
  expect([...writes[0]]).toEqual([1, 2]);
  expect(clock.cancelled.length).toBe(1);
  clock.fire();
  expect(writes.length).toBe(1);
});

test("flush with nothing queued is a no-op", () => {
  const out = buffer();
  const clock = fakeFrames();
  let writes = 0;
  flushOutputBuffer(out, () => writes++, clock.frames);
  expect(writes).toBe(0);
  expect(clock.cancelled.length).toBe(0);
});

test("clear drops queued chunks without writing, as on reconnect", () => {
  const out = buffer();
  const clock = fakeFrames();
  let writes = 0;
  queueOutputChunk(out, bytes(1), () => writes++, clock.frames);
  clearOutputBuffer(out, clock.frames);
  clock.fire();
  expect(writes).toBe(0);
  expect(out.pendingBytes).toBe(0);
  expect(out.outputFrame).toBeNull();
});

test("chunks after a flush schedule a fresh frame", () => {
  const out = buffer();
  const clock = fakeFrames();
  const writes: Uint8Array[] = [];
  const write = (data: Uint8Array) => writes.push(data);
  queueOutputChunk(out, bytes(1), write, clock.frames);
  clock.fire();
  queueOutputChunk(out, bytes(2), write, clock.frames);
  expect(clock.size).toBe(1);
  clock.fire();
  expect(writes.length).toBe(2);
  expect([...writes[1]]).toEqual([2]);
});

test("writes immediately while frames are paused so hidden tabs still answer queries", () => {
  const out = buffer();
  const clock = fakeFrames();
  const writes: Uint8Array[] = [];
  const write = (data: Uint8Array) => writes.push(data);
  queueOutputChunk(out, bytes(1), write, clock.frames);
  clock.state.hidden = true;
  queueOutputChunk(out, bytes(0x1b, 0x5b, 0x36, 0x6e), write, clock.frames);
  expect(writes.length).toBe(1);
  expect([...writes[0]]).toEqual([1, 0x1b, 0x5b, 0x36, 0x6e]);
  expect(clock.size).toBe(0);
  expect(out.pendingBytes).toBe(0);
});

test("a coalesced burst restores the scrolled-back viewport once", () => {
  const out = buffer();
  const clock = fakeFrames();
  const term = terminal(30, "normal", 2);
  const write = (data: Uint8Array) => writeTerminalOutput(term, data);
  queueOutputChunk(out, bytes(1), write, clock.frames);
  queueOutputChunk(out, bytes(2), write, clock.frames);
  queueOutputChunk(out, bytes(3), write, clock.frames);
  clock.fire();
  expect(term.restored).toEqual([32]);
  expect(term.viewportY).toBe(32);
});
