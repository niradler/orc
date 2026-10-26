import { describe, expect, test } from "bun:test";
import { readProcessOutput } from "../io.js";

const encode = (text: string) => new TextEncoder().encode(text);

function controlledStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return { stream, controller };
}

describe("readProcessOutput", () => {
  test("delivers every line, including an unterminated last one, then drains", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const drain = readProcessOutput(
      {
        stdout: new Response("one\n\ntwo\nthree").body,
        stderr: new Response("oops\n").body,
      },
      { stdout: (line) => out.push(line), stderr: (line) => err.push(line) },
    );
    await drain();
    expect(out).toEqual(["one", "two", "three"]);
    expect(err).toEqual(["oops"]);
  });

  test("reports a failed pipe and still drains", async () => {
    const stdout = controlledStream();
    const failures: string[] = [];
    const drain = readProcessOutput(
      { stdout: stdout.stream },
      { stdout: () => {}, onError: (_err, stream) => failures.push(stream) },
    );
    stdout.controller.error(new Error("pipe broke"));
    await drain(1000);
    expect(failures).toEqual(["stdout"]);
  });

  test("stops delivering lines once the drain timeout gives up on an open pipe", async () => {
    const stdout = controlledStream();
    const lines: string[] = [];
    const drain = readProcessOutput(
      { stdout: stdout.stream },
      { stdout: (line) => lines.push(line) },
    );
    stdout.controller.enqueue(encode("before\n"));
    const started = Date.now();
    await drain(50);
    expect(Date.now() - started).toBeLessThan(1000);
    try {
      stdout.controller.enqueue(encode("after\n"));
    } catch {
      // the cancelled stream may already refuse writes
    }
    await Bun.sleep(20);
    expect(lines).toEqual(["before"]);
  });
});
