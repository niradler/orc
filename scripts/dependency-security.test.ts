import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "orc-dependency-security-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const repo = resolve(import.meta.dir, "..");
const runnerRequire = createRequire(join(repo, "packages/runner/package.json"));
const chokidarRequire = createRequire(runnerRequire.resolve("chokidar"));

function version(entry: string): string {
  let directory = dirname(entry);
  while (true) {
    const path = join(directory, "package.json");
    if (existsSync(path)) {
      const metadata = JSON.parse(readFileSync(path, "utf8"));
      if (typeof metadata.version === "string") return metadata.version;
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot find metadata for ${entry}`);
    directory = parent;
  }
}

type Braces = {
  parse: (input: string) => unknown;
  compile: (input: unknown) => string;
  expand: (input: unknown) => string[];
  stringify: (input: unknown) => string;
};
for (const [name, resolver] of [["runner watcher", chokidarRequire]] as const) {
  const braces = resolver("braces") as Braces;
  test(`${name}: hostile nesting is a bounded validation error, ordinary patterns still work`, () => {
    for (const method of [braces.parse, braces.compile, braces.expand, braces.stringify]) {
      for (const pattern of [
        `${"{".repeat(4000)}a,b${"}".repeat(4000)}`,
        `${"(".repeat(4000)}a${")".repeat(4000)}`,
      ]) {
        expect(() => method(pattern)).toThrow(SyntaxError);
        expect(() => method(pattern)).toThrow("nesting");
      }
    }
    expect(braces.expand("src/{api,core}/{one,two}.ts")).toEqual([
      "src/api/one.ts",
      "src/api/two.ts",
      "src/core/one.ts",
      "src/core/two.ts",
    ]);
    expect(braces.expand("file-{1..3}.ts")).toEqual(["file-1.ts", "file-2.ts", "file-3.ts"]);
    expect(braces.compile("{a,b}")).toBe("(a|b)");
    expect(braces.stringify(braces.parse("{a,b}"))).toBe("{a,b}");
  });
  test(`${name}: externally supplied deep ASTs cannot bypass parser protection`, () => {
    for (const method of [braces.compile, braces.expand, braces.stringify]) {
      let ast: { type: string; nodes: unknown[] } = { type: "root", nodes: [] };
      for (let i = 0; i < 1000; i++) ast = { type: "root", nodes: [ast] };
      expect(() => method(ast)).toThrow("nesting");
    }
  });
}

test("API IP parsing and YAML use patched dependency versions", () => {
  const apiRequire = createRequire(join(repo, "packages/api/package.json"));
  const mcpRequire = createRequire(apiRequire.resolve("@modelcontextprotocol/sdk/server/index.js"));
  expect(
    Bun.semver.satisfies(
      version(apiRequire.resolve("@modelcontextprotocol/sdk/server/index.js")),
      ">=1.32.2 <2",
    ),
  ).toBe(true);
  const limiterRequire = createRequire(mcpRequire.resolve("express-rate-limit"));
  expect(Bun.semver.satisfies(version(limiterRequire.resolve("ip-address")), ">=10.7.5 <11")).toBe(
    true,
  );
  const { Address4 } = limiterRequire("ip-address") as {
    Address4: new (value: string) => { correctForm: () => string };
  };
  expect(() => new Address4("0177.0.0.1")).toThrow();
  expect(new Address4("127.0.0.1").correctForm()).toBe("127.0.0.1");
  const sdkRequire = createRequire(
    Bun.resolveSync("openapi-typescript", join(repo, "packages/sdk")),
  );
  const redoclyRequire = createRequire(sdkRequire.resolve("@redocly/openapi-core"));
  expect(version(redoclyRequire.resolve("js-yaml"))).toBe("4.3.2");
  const yaml = redoclyRequire("js-yaml") as { load: (source: string) => unknown };
  expect(yaml.load("base: &base\n  enabled: true\ncopy:\n  <<: *base\n")).toEqual({
    base: { enabled: true },
    copy: { enabled: true },
  });
});
