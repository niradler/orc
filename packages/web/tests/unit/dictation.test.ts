import { expect, test } from "bun:test";
import { dictationClock, insertDictation, microphoneError, wavFile } from "../../src/lib/dictation";

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
