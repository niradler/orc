import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  bumpPatch,
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
