import { describe, expect, test } from "bun:test";
import { applyEdits, lineStarts, numberedLines } from "../edit.js";

const doc = "one\ntwo\nthree\nfour\n";

describe("applyEdits", () => {
  test("replaces text that matches once", () => {
    expect(applyEdits(doc, [{ old: "two", new: "TWO" }])).toEqual({
      text: "one\nTWO\nthree\nfour\n",
      changed: [{ start_line: 2, end_line: 2 }],
    });
  });

  test("refuses text that matches zero or several times, unless replace_all", () => {
    expect(() => applyEdits(doc, [{ old: "five", new: "x" }])).toThrow("not found");
    expect(() => applyEdits("a a", [{ old: "a", new: "b" }])).toThrow("matches 2 times");
    expect(applyEdits("a\na\n", [{ old: "a", new: "b", replace_all: true }])).toEqual({
      text: "b\nb\n",
      changed: [
        { start_line: 1, end_line: 1 },
        { start_line: 2, end_line: 2 },
      ],
    });
  });

  test("replaces, deletes and inserts whole lines", () => {
    expect(applyEdits(doc, [{ start_line: 2, end_line: 3, new: "middle" }]).text).toBe(
      "one\nmiddle\nfour\n",
    );
    const del = applyEdits(doc, [{ start_line: 2, end_line: 2, new: "" }]);
    expect(del.text).toBe("one\nthree\nfour\n");
    expect(del.changed).toEqual([{ start_line: 2, end_line: 1 }]);
    expect(applyEdits(doc, [{ start_line: 1, end_line: 0, new: "zero" }]).text).toBe(
      `zero\n${doc}`,
    );
    expect(applyEdits(doc, [{ start_line: 5, end_line: 4, new: "five" }]).text).toBe(
      `${doc}five\n`,
    );
    expect(applyEdits("a\nb", [{ start_line: 3, end_line: 2, new: "c" }]).text).toBe("a\nb\nc");
    expect(applyEdits("", [{ start_line: 1, end_line: 0, new: "first" }]).text).toBe("first");
  });

  test("refuses line ranges outside the document", () => {
    expect(() => applyEdits(doc, [{ start_line: 4, end_line: 5, new: "x" }])).toThrow(
      "it has 4 lines",
    );
    expect(() => applyEdits(doc, [{ start_line: 3, end_line: 1, new: "x" }])).toThrow();
  });

  test("all edits refer to the revision read, so earlier edits never shift later lines", () => {
    const out = applyEdits(doc, [
      { start_line: 1, end_line: 1, new: "1a\n1b\n1c" },
      { start_line: 4, end_line: 4, new: "FOUR" },
      { old: "three", new: "THREE" },
    ]);
    expect(out.text).toBe("1a\n1b\n1c\ntwo\nTHREE\nFOUR\n");
    expect(out.changed).toEqual([
      { start_line: 1, end_line: 3 },
      { start_line: 6, end_line: 6 },
      { start_line: 5, end_line: 5 },
    ]);
  });

  test("refuses overlapping edits", () => {
    expect(() =>
      applyEdits(doc, [
        { start_line: 2, end_line: 3, new: "x" },
        { old: "three", new: "y" },
      ]),
    ).toThrow("Edits 1 and 2 change the same text");
  });
});

describe("numberedLines", () => {
  test("numbers a range and reports the total", () => {
    expect(numberedLines(doc, 2, 3)).toEqual({
      text: "2| two\n3| three",
      start_line: 2,
      end_line: 3,
      total_lines: 4,
    });
    expect(numberedLines(doc, 3).text).toBe("3| three\n4| four");
    expect(lineStarts("a\nb\n")).toEqual([0, 2]);
  });
});
