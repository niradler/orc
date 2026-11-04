import { describe, expect, test } from "bun:test";
import {
  boundedEditDistance,
  closestMatch,
  compareText,
  normalizeText,
  textProfile,
} from "./similarity.js";

const base =
  "Always run the full test suite before committing. Never dismiss failures as pre-existing; fix them or report them.";

describe("similarity", () => {
  test("normalization makes line endings and trailing spaces irrelevant", () => {
    expect(normalizeText("﻿a  b \r\nc\r\n\r\n\r\n\r\nd\n")).toBe("a b\nc\n\nd");
    expect(compareText("one\r\ntwo  \n", "one\ntwo").level).toBe("identical");
  });

  test("a one-letter change is near, not new", () => {
    const result = compareText(base, base.replace("committing", "comitting"));
    expect(result.level).toBe("near");
    expect(result.score).toBeGreaterThan(0.99);
  });

  test("a one-letter change in a short text is still near", () => {
    expect(
      compareText("Prefer bun over npm in this repo", "Prefer bun over pnpm in this repo").level,
    ).toBe("near");
    expect(compareText("cat", "cut").level).toBe("different");
  });

  test("a changed sentence is similar, unrelated text is different", () => {
    const edited = `${base} Use local CI.`;
    expect(compareText(base, edited).level).toBe("similar");
    expect(compareText(base, "Deploy the lab with docker compose up -d --build.").level).toBe(
      "different",
    );
  });

  test("large texts use gram overlap for near", () => {
    const large = Array.from({ length: 3000 }, (_, index) => `line ${index} of the skill`).join(
      "\n",
    );
    expect(compareText(large, large.replace("line 10 ", "line 1O ")).level).toBe("near");
  });

  test("bounded edit distance stops at the limit", () => {
    expect(boundedEditDistance("kitten", "sitting", 5)).toBe(3);
    expect(boundedEditDistance("kitten", "sitting", 2)).toBe(3);
    expect(boundedEditDistance("", "abcd", 10)).toBe(4);
  });

  test("closestMatch prefers the strongest level", () => {
    const candidates = [
      { key: "similar", profile: textProfile(`${base} Extra closing sentence about it.`) },
      { key: "near", profile: textProfile(base.replace("full", "ful")) },
      { key: "other", profile: textProfile("unrelated") },
    ];
    expect(closestMatch(textProfile(base), candidates)?.key).toBe("near");
    expect(closestMatch(textProfile("zzz"), candidates)).toBeNull();
  });
});
