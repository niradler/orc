import { expect, test } from "bun:test";
import {
  createDecimator,
  dictationClock,
  dictationLimitMs,
  insertDictation,
  microphoneError,
  wavFile,
} from "../../src/lib/dictation";

test("a transcript lands at the cursor with word spacing and the caret after it", () => {
  expect(insertDictation("", 0, 0, "  hello there ")).toEqual({
    value: "hello there",
    caret: 11,
  });
  expect(insertDictation("fix the bug", 7, 7, "login")).toEqual({
    value: "fix the login bug",
    caret: 13,
  });
  expect(insertDictation("fix the", 7, 7, "login bug")).toEqual({
    value: "fix the login bug",
    caret: 17,
  });
  expect(insertDictation("Say hi.", 6, 6, "there")).toEqual({
    value: "Say hi there.",
    caret: 12,
  });
  expect(insertDictation("replace THIS now", 8, 12, "that")).toEqual({
    value: "replace that now",
    caret: 12,
  });
  expect(insertDictation("line\n", 5, 5, "next")).toEqual({ value: "line\nnext", caret: 9 });
  expect(insertDictation("keep", 4, 4, "   ")).toBeNull();
});

test("recorded samples become 16-bit mono WAV behind a 44-byte header", () => {
  const wav = wavFile([Float32Array.from([0, 1, -1]), Float32Array.from([0.5, 2])], 16_000);
  expect(Buffer.from(wav).toString("hex")).toBe(
    [
      "52494646",
      "2e000000",
      "57415645",
      "666d7420",
      "10000000",
      "0100",
      "0100",
      "803e0000",
      "007d0000",
      "0200",
      "1000",
      "64617461",
      "0a000000",
      "0000",
      "ff7f",
      "0080",
      "ff3f",
      "ff7f",
    ].join(""),
  );
  const empty = wavFile([], 16_000);
  expect(empty.length).toBe(44);
  expect(new DataView(empty.buffer).getUint32(40, true)).toBe(0);
});

test("a 44.1 kHz microphone is averaged down to 16 kHz across chunk boundaries", () => {
  const ramp = Float32Array.from({ length: 441 }, (_, i) => i);
  const out = createDecimator(44_100, 16_000)(ramp);
  expect(out.length).toBe(159);
  expect(Array.from(out.slice(0, 6))).toEqual([1, 4, 7, 10, 12.5, 15]);
  expect(out.at(-1)).toBe(437);

  const second = Float32Array.from({ length: 44_100 }, (_, i) => Math.sin(i / 7));
  const whole = createDecimator(44_100, 16_000)(second);
  const chunked = createDecimator(44_100, 16_000);
  const parts: number[] = [];
  for (let i = 0; i < second.length; i += 128) parts.push(...chunked(second.subarray(i, i + 128)));
  expect(whole.length).toBe(15_999);
  expect(Float32Array.from(parts)).toEqual(whole);
  expect(createDecimator(16_000, 16_000)(Float32Array.from([0.25, -0.5]))).toEqual(
    Float32Array.from([0.25, -0.5]),
  );
});

test("a provider byte limit shortens the recording so the WAV always fits", () => {
  expect(dictationLimitMs(7_400_000, 16_000)).toBe(231_248);
  expect(44 + (231_248 / 1000) * 16_000 * 2).toBeLessThanOrEqual(7_400_000);
  expect(dictationLimitMs(25 * 1024 * 1024, 16_000)).toBe(300_000);
  expect(dictationLimitMs(0, 16_000)).toBe(300_000);
});

test("elapsed time reads as minutes and seconds", () => {
  expect(dictationClock(0)).toBe("0:00");
  expect(dictationClock(7_900)).toBe("0:07");
  expect(dictationClock(300_000)).toBe("5:00");
});

test("microphone failures read as actions the user can take", () => {
  expect(microphoneError(new DOMException("denied", "NotAllowedError"))).toContain(
    "Allow it in site settings",
  );
  expect(microphoneError(new DOMException("none", "NotFoundError"))).toBe("No microphone found.");
  expect(microphoneError(new DOMException("busy", "NotReadableError"))).toContain("in use");
});
