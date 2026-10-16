import { describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { assertZipWithinLimits } from "../parsers/basic.js";

const zeros = (n: number) => new Uint8Array(n);

describe("assertZipWithinLimits", () => {
  test("accepts an archive inside the limits", async () => {
    const zip = zipSync({ "a.xml": zeros(1000), "b.xml": zeros(1000) });
    await assertZipWithinLimits(zip, { maxEntries: 5, maxExpandedBytes: 10_000 });
  });

  test("refuses an archive that inflates past the byte limit", async () => {
    // 8 MB of zeros compresses to a few KB: the real inflated size is what must be counted.
    const zip = zipSync({ "bomb.xml": zeros(8 * 2 ** 20) }, { level: 9 });
    expect(zip.length).toBeLessThan(64 * 1024);
    await expect(
      assertZipWithinLimits(zip, { maxEntries: 5, maxExpandedBytes: 2 ** 20 }),
    ).rejects.toThrow(/expands past/);
  });

  test("refuses an archive with too many entries", async () => {
    const files = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}.xml`, zeros(1)]));
    await expect(
      assertZipWithinLimits(zipSync(files), { maxEntries: 10, maxExpandedBytes: 2 ** 20 }),
    ).rejects.toThrow(/more than 10 entries/);
  });
});
