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

test("should safely serialize hostile query-string array elements through the API dependencies", () => {
  const apiRequire = createRequire(join(repo, "packages/api/package.json"));
  const mcpRequire = createRequire(apiRequire.resolve("@modelcontextprotocol/sdk/server/index.js"));
  const expressRequire = createRequire(mcpRequire.resolve("express"));
  const qs = expressRequire("qs") as {
    stringify: (
      input: unknown,
      options: { arrayFormat: "comma"; encodeValuesOnly?: boolean },
    ) => string;
  };
  expect(Bun.semver.satisfies(version(expressRequire.resolve("qs")), ">=6.16.1 <7")).toBe(true);
  const hostile: unknown = JSON.parse('{"a":[{"toString":"x"}]}');
  for (const encodeValuesOnly of [false, true])
    expect(qs.stringify(hostile, { arrayFormat: "comma", encodeValuesOnly })).toBe(
      "a=%5Bobject%20Object%5D",
    );
  expect(qs.stringify({ a: ["one", "two"] }, { arrayFormat: "comma" })).toBe("a=one%2Ctwo");
});

test("should bound minimatch preprocessing through both desktop dependency paths", () => {
  const desktopRequire = createRequire(join(repo, "packages/desktop/package.json"));
  const electronBuilderRequire = createRequire(desktopRequire.resolve("electron-builder"));
  const builderRequire = createRequire(electronBuilderRequire.resolve("app-builder-lib"));
  const universalRequire = createRequire(builderRequire.resolve("@electron/universal"));
  for (const resolver of [builderRequire, universalRequire]) {
    const entry = resolver.resolve("minimatch");
    expect(Bun.semver.satisfies(version(entry), ">=11.0.3 <12")).toBe(true);
    const child = Bun.spawnSync(
      [
        process.execPath,
        "--eval",
        `const {Minimatch}=require(${JSON.stringify(entry)});` +
          `const pattern=Array(10).fill('**/../x/y').join('/');` +
          `const matcher=new Minimatch(pattern,{optimizationLevel:2,braceExpandMax:64});` +
          `console.log(JSON.stringify({patterns:matcher.set.length,ordinary:new Minimatch('**/*.ts').match('src/index.ts')}));`,
      ],
      { timeout: 5000, stdout: "pipe", stderr: "pipe" },
    );
    expect(child.exitCode).toBe(0);
    const result = JSON.parse(child.stdout.toString());
    expect(result.patterns).toBeLessThanOrEqual(64);
    expect(result.ordinary).toBe(true);
  }
});

test("should preserve legacy callable minimatch APIs used by packaging and SDK generation", () => {
  const desktopRequire = createRequire(join(repo, "packages/desktop/package.json"));
  const electronBuilderRequire = createRequire(desktopRequire.resolve("electron-builder"));
  const builderRequire = createRequire(electronBuilderRequire.resolve("app-builder-lib"));
  const asarRequire = createRequire(builderRequire.resolve("@electron/asar"));
  const sdkRequire = createRequire(
    Bun.resolveSync("openapi-typescript", join(repo, "packages/sdk")),
  );
  const redoclyRequire = createRequire(sdkRequire.resolve("@redocly/openapi-core"));
  for (const resolver of [asarRequire, redoclyRequire]) {
    const match = resolver("minimatch") as (path: string, pattern: string) => boolean;
    expect(typeof match).toBe("function");
    expect(match("src/index.ts", "**/*.ts")).toBe(true);
    expect(match("src/index.js", "**/*.ts")).toBe(false);
  }
});
