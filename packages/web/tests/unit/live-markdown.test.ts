import { describe, expect, test } from "bun:test";
import { parseTable, prefixLines, tableTemplate } from "../../src/lib/live-markdown";

describe("live Markdown helpers", () => {
  test("parses a GFM table with alignment", () => {
    expect(
      parseTable([
        "| State | Meaning | Action |",
        "| :--- | :---: | ---: |",
        "| Needs you | A question is pending | Answer inline |",
      ]),
    ).toEqual({
      headers: ["State", "Meaning", "Action"],
      aligns: ["left", "center", "right"],
      rows: [["Needs you", "A question is pending", "Answer inline"]],
    });
    expect(parseTable(["| not | a table |"])).toBeNull();
  });

  test("builds a table template with a header and separator", () => {
    const lines = tableTemplate(2).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe("| --- | --- |");
  });

  test("prefixes each selected line", () => {
    expect(prefixLines("one\ntwo", "- ")).toBe("- one\n- two");
    expect(prefixLines("one\ntwo", (i) => `${i + 1}. `)).toBe("1. one\n2. two");
  });
});
