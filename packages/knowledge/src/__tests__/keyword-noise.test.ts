import { expect, test } from "bun:test";
import { ftsQuery, IndexDb } from "../index-db.js";

test("relaxed keyword search does not boost unrelated passages for question filler words", async () => {
  const index = await IndexDb.open(":memory:");
  try {
    index.replaceDocument({
      document_id: "irrelevant",
      kb_id: "kb",
      revision: 1,
      title: "Networking",
      labels: [],
      media_type: "text/plain",
      chunks: [
        {
          ordinal: 0,
          heading_path: [],
          locator: null,
          text: "A failed resolver prevents locating a service.",
        },
      ],
    });
    expect(
      index.lexical("What ingredients should I use for a fermented loaf?", { kb_ids: ["kb"] }, 10),
    ).toEqual([]);
  } finally {
    index.close();
  }
});

test("keyword fallback retains all-filler searches, identifiers and non-English terms", () => {
  expect(ftsQuery("to be", "OR")).toBe('"to" OR "be"');
  expect(ftsQuery("the DNS resolver", "AND")).toBe('"the" AND "DNS" AND "resolver"*');
  expect(ftsQuery("the DNS resolver", "OR")).toBe('"DNS" OR "resolver"*');
  expect(ftsQuery("תיקון חיבור", "OR")).toBe('"תיקון" OR "חיבור"*');
  expect(ftsQuery("v2 api_key x", "OR")).toBe('"v2" OR "api_key" OR "x"');
});
