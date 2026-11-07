import { describe, expect, test } from "bun:test";
import { assertUpdatePayload, parseUpdateInfo, updateInfoFileName } from "./update-metadata.js";

describe("desktop update metadata", () => {
  test("uses the platform file electron-updater requests", () => {
    expect(updateInfoFileName("windows-x64")).toBe("latest.yml");
    expect(updateInfoFileName("mac-arm64")).toBe("latest-mac.yml");
    expect(updateInfoFileName("linux-x64")).toBe("latest-linux.yml");
    expect(updateInfoFileName("linux-arm64")).toBe("latest-linux-arm64.yml");
    expect(() => updateInfoFileName("windows-arm64")).toThrow("Unsupported desktop target");
  });

  test("accepts a generated update manifest and rejects unsafe file names", () => {
    const info = parseUpdateInfo(`version: 0.1.61
files:
  - url: orc-0.1.61-mac-arm64.zip
    sha512: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
    size: 10
    blockMapSize: 4
  - url: orc-0.1.61-mac-arm64.dmg
    sha512: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
path: orc-0.1.61-mac-arm64.zip
sha512: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
releaseDate: '2026-11-07T00:00:00.000Z'
`);
    expect(info.files.map((file) => file.url)).toEqual([
      "orc-0.1.61-mac-arm64.zip",
      "orc-0.1.61-mac-arm64.dmg",
    ]);
    expect(info.files[0]?.blockMapSize).toBe(4);
    assertUpdatePayload("mac-arm64", info);
    expect(() =>
      parseUpdateInfo(`version: 0.1.61
files:
  - url: ../orc.exe
    sha512: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
`),
    ).toThrow("file name");
    expect(() =>
      assertUpdatePayload("mac-arm64", {
        version: "0.1.61",
        files: [{ url: "orc-0.1.61-mac-arm64.dmg", sha512: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }],
      }),
    ).toThrow("does not reference its installer");
  });
});
