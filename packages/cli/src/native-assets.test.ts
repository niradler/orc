import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { extractNativeAsset } from "./native-assets.js";

const dirs: string[] = [];
function fixture(bytes: string) {
  const dir = mkdtempSync(join(tmpdir(), "orc-native-"));
  dirs.push(dir);
  const path = join(dir, "embedded.bin");
  writeFileSync(path, bytes);
  return { asset: { path, name: "vec0.so" }, cache: join(dir, "cache") };
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("extractNativeAsset", () => {
  test("writes the bundled bytes under a content-hash directory and reuses them", () => {
    const { asset, cache } = fixture("library v1");
    const first = extractNativeAsset(asset, cache);
    expect(first).not.toBeNull();
    expect(readFileSync(first as string, "utf8")).toBe("library v1");
    expect(extractNativeAsset(asset, cache)).toBe(first);

    // An upgraded binary extracts beside the old copy instead of overwriting it.
    writeFileSync(asset.path, "library v2");
    const second = extractNativeAsset(asset, cache);
    expect(dirname(second as string)).not.toBe(dirname(first as string));
    expect(readFileSync(first as string, "utf8")).toBe("library v1");
  });

  test("refuses a cached copy that was modified", () => {
    const { asset, cache } = fixture("library v1");
    const target = extractNativeAsset(asset, cache) as string;
    writeFileSync(target, "tampered");
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(extractNativeAsset(asset, cache)).toBeNull();
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
    expect(readFileSync(target, "utf8")).toBe("tampered");
  });
});
