import { describe, expect, test } from "bun:test";
import { volatileBinPath } from "./daemon.js";

describe("daemon install binary path guard", () => {
  test("rejects the fnm per-shell path from the bug report", () => {
    expect(
      volatileBinPath("/Users/nir/.local/state/fnm_multishells/8188_1788532082554/bin/orc"),
    ).toBe("fnm_multishells");
  });

  test("rejects nvm, volta, asdf and nodenv version paths", () => {
    expect(volatileBinPath("/Users/nir/.nvm/versions/node/v22.3.0/bin/orc")).toBe(
      "/.nvm/versions/",
    );
    expect(volatileBinPath("/Users/nir/.volta/tools/image/node/22.3.0/bin/orc")).toBe(
      "/.volta/tools/",
    );
    expect(volatileBinPath("/Users/nir/.asdf/installs/nodejs/22.3.0/bin/orc")).toBe(
      "/.asdf/installs/",
    );
    expect(volatileBinPath("/Users/nir/.nodenv/versions/22.3.0/bin/orc")).toBe("nodenv/versions/");
  });

  test("accepts a stable path", () => {
    expect(volatileBinPath("/Users/nir/.local/bin/orc")).toBeNull();
    expect(volatileBinPath("/usr/local/bin/orc")).toBeNull();
    expect(volatileBinPath("/opt/homebrew/bin/orc")).toBeNull();
  });

  test("normalises Windows separators before matching", () => {
    expect(volatileBinPath("C:\\Users\\nir\\.volta\\tools\\image\\node\\22.3.0\\orc.exe")).toBe(
      "/.volta/tools/",
    );
  });
});
