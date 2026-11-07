import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  bumpPatch,
  collectDesktopUpdateAssets,
  completeStep,
  desktopMatrix,
  installerName,
  run,
  TARGETS,
} from "./release-lib.js";
import { desktopLaunchEnv } from "./update-desktop.js";

describe("release safety", () => {
  test("should keep the default invocation read-only even with uncommitted changes", () => {
    const manifest = resolve(import.meta.dir, "../package.json");
    const before = readFileSync(manifest, "utf8");
    const output = run(process.execPath, [resolve(import.meta.dir, "release.ts")], {
      capture: true,
      quiet: true,
      timeout: 10_000,
    });
    expect(output).toContain("Run bun run release --yes");
    expect(readFileSync(manifest, "utf8")).toBe(before);
  });
  test("should invoke the installed npm CLI without a shell", () => {
    expect(run("npm", ["--version"], { capture: true, quiet: true, timeout: 10_000 })).toMatch(
      /^\d+\.\d+\.\d+$/,
    );
  });
  test("should refuse local preparation without explicit execution before changing release state", () => {
    const manifest = resolve(import.meta.dir, "../package.json");
    const checkpoint = resolve(import.meta.dir, "../.orc/release-state.json");
    const before = readFileSync(manifest, "utf8");
    const state = existsSync(checkpoint) ? readFileSync(checkpoint, "utf8") : undefined;
    expect(() =>
      run(process.execPath, [resolve(import.meta.dir, "release.ts"), "--prepare"], {
        capture: true,
        quiet: true,
        timeout: 10_000,
      }),
    ).toThrow("--prepare requires --yes");
    expect(readFileSync(manifest, "utf8")).toBe(before);
    expect(existsSync(checkpoint) ? readFileSync(checkpoint, "utf8") : undefined).toBe(state);
  });
  test("should reject combining verification with publication before touching release state", () => {
    const manifest = resolve(import.meta.dir, "../package.json");
    const before = readFileSync(manifest, "utf8");
    expect(() =>
      run(process.execPath, [resolve(import.meta.dir, "release.ts"), "--verify", "--yes"], {
        capture: true,
        quiet: true,
        timeout: 10_000,
      }),
    ).toThrow("cannot be combined");
    expect(readFileSync(manifest, "utf8")).toBe(before);
  });
  test("should resume after a failed publish without repeating completed stages", async () => {
    const completed: string[] = [];
    let releases = 0;
    let saves = 0;
    const save = (): void => {
      saves++;
    };
    const publish = (): void => {
      releases++;
    };
    await completeStep(completed, "github", publish, save);
    await expect(
      completeStep(
        completed,
        "npm",
        () => {
          throw new Error("authentication expired");
        },
        save,
      ),
    ).rejects.toThrow("authentication expired");
    expect(completed).toEqual(["github"]);
    await completeStep(completed, "github", publish, save);
    await completeStep(completed, "npm", () => {}, save);
    expect(releases).toBe(1);
    expect(saves).toBe(2);
    expect(completed).toEqual(["github", "npm"]);
  });
  test("should send only non-local desktop targets to Actions and reject stale plans", () => {
    for (const target of TARGETS) {
      const matrix = desktopMatrix("0.1.30", target.id, "0.1.30");
      expect(matrix.include).toHaveLength(3);
      expect(matrix.include.some((entry) => entry.id === target.id)).toBe(false);
    }
    expect(() => desktopMatrix("0.1.29", "windows-x64", "0.1.30")).toThrow();
    expect(() => desktopMatrix("0.1.30", "untrusted", "0.1.30")).toThrow();
  });
  test("should bump only the patch and reject unstable or unsafe versions", () => {
    expect(bumpPatch("0.1.29")).toBe("0.1.30");
    expect(bumpPatch("1.9.99")).toBe("1.9.100");
    for (const version of ["1.2", "1.2.3-beta", "1.2.3;echo secret", "latest"])
      expect(() => bumpPatch(version)).toThrow();
  });
  test("should publish updater metadata beside installers and keep the macOS zip", () => {
    const root = mkdtempSync(join(tmpdir(), "orc-update-"));
    try {
      const windows = join(root, "windows");
      const mac = join(root, "mac");
      const linux = join(root, "linux");
      const arm = join(root, "arm");
      for (const directory of [windows, mac, linux, arm]) mkdirSync(directory);
      writeFileSync(join(windows, "orc-0.1.30-win-x64.exe"), "exe");
      writeFileSync(join(windows, "orc-0.1.30-win-x64.exe.blockmap"), "map");
      writeFileSync(
        join(windows, "latest.yml"),
        `version: 0.1.30
files:
  - url: orc-0.1.30-win-x64.exe
    sha512: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
    blockMapSize: 3
`,
      );
      writeFileSync(join(mac, "orc-0.1.30-mac-arm64.dmg"), "dmg");
      writeFileSync(join(mac, "orc-0.1.30-mac-arm64.zip"), "zip");
      writeFileSync(
        join(mac, "latest-mac.yml"),
        `version: 0.1.30
files:
  - url: orc-0.1.30-mac-arm64.zip
    sha512: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
  - url: orc-0.1.30-mac-arm64.dmg
    sha512: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
`,
      );
      writeFileSync(join(linux, "orc-0.1.30-linux-x86_64.AppImage"), "app");
      writeFileSync(
        join(linux, "latest-linux.yml"),
        `version: 0.1.30
files:
  - url: orc-0.1.30-linux-x86_64.AppImage
    sha512: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
`,
      );
      writeFileSync(join(arm, "orc-0.1.30-linux-arm64.AppImage"), "app");
      writeFileSync(
        join(arm, "latest-linux-arm64.yml"),
        `version: 0.1.30
files:
  - url: orc-0.1.30-linux-arm64.AppImage
    sha512: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
`,
      );
      const included = new Set([
        "orc-0.1.30-win-x64.exe",
        "orc-0.1.30-mac-arm64.dmg",
        "orc-0.1.30-linux-x86_64.AppImage",
        "orc-0.1.30-linux-arm64.AppImage",
      ]);
      const assets = collectDesktopUpdateAssets({
        version: "0.1.30",
        directories: [
          { id: "windows-x64", directory: windows },
          { id: "mac-arm64", directory: mac },
          { id: "linux-x64", directory: linux },
          { id: "linux-arm64", directory: arm },
        ],
        included,
        read: (path) => readFileSync(path, "utf8"),
        exists: existsSync,
      }).map((file) => file.slice(root.length + 1).replaceAll("\\", "/"));
      expect(assets).toEqual([
        "arm/latest-linux-arm64.yml",
        "linux/latest-linux.yml",
        "mac/latest-mac.yml",
        "windows/latest.yml",
        "mac/orc-0.1.30-mac-arm64.zip",
        "windows/orc-0.1.30-win-x64.exe.blockmap",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("should collect the prerelease channel metadata generated by electron-builder", () => {
    const readPaths: string[] = [];
    const assets = collectDesktopUpdateAssets({
      version: "0.1.61-beta.1",
      directories: [{ id: "windows-x64", directory: "release" }],
      included: new Set(),
      exists: () => true,
      read: (path) => {
        readPaths.push(path);
        return "version: 0.1.61-beta.1\nfiles:\n  - url: orc-beta.exe\n    sha512: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n";
      },
    });
    expect(readPaths).toEqual([join("release", "beta.yml")]);
    expect(assets).toContain(join("release", "beta.yml"));
    expect(assets).toContain(join("release", "orc-beta.exe"));
  });

  test("should produce unique, versioned installers for every supported desktop target", () => {
    const files = TARGETS.map((target) => installerName("0.1.30", target.id));
    expect(new Set(files).size).toBe(4);
    expect(files).toContain("orc-0.1.30-mac-arm64.dmg");
    expect(files).toContain("orc-0.1.30-win-x64.exe");
    expect(files).toContain("orc-0.1.30-linux-x86_64.AppImage");
    expect(() => installerName("0.1.30", "windows-arm64")).toThrow();
  });
  test("should isolate the installed desktop from development ports and data paths", () => {
    const source = {
      ORC_API_PORT: "7711",
      ORC_WEB_PORT: "3077",
      ORC_API_BASE: "http://localhost:7711",
      ORC_DB_PATH: "temporary.db",
      ORC_WEB_DIST: "temporary-dist",
      PATH: "tools",
      ORC_API_SECRET: "test-secret",
    };
    expect(desktopLaunchEnv(source)).toEqual({ PATH: "tools", ORC_API_SECRET: "test-secret" });
    expect(desktopLaunchEnv({ PATH: "tools", ORC_API_SECRET: "" })).toEqual({ PATH: "tools" });
    expect(desktopLaunchEnv({ orc_api_secret: "", HOME: "user" })).toEqual({ HOME: "user" });
    expect(source.ORC_API_PORT).toBe("7711");
    expect(desktopLaunchEnv({ orc_api_port: "7711", HOME: "user" })).toEqual({ HOME: "user" });
  });
  test("should preserve process errors rather than treating empty output as success", () => {
    expect(() =>
      run(process.execPath, ["-e", "process.exit(17)"], {
        capture: true,
        quiet: true,
        timeout: 1000,
      }),
    ).toThrow("17");
  });
  test("should bound hung release commands", () => {
    expect(() =>
      run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        capture: true,
        quiet: true,
        timeout: 100,
      }),
    ).toThrow();
  });
});
