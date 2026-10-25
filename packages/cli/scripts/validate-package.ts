#!/usr/bin/env bun
/**
 * Validates the publishable `orc-ai` tarball before it ships to npm.
 *
 * Catches the class of bug where a runtime dependency is bundled into
 * `dist/index.js` but still resolves files relative to its own package at
 * runtime (e.g. `@anthropic-ai/claude-agent-sdk` locating its `cli.js` via
 * `import.meta.url`). Such deps MUST stay external + declared so npm installs
 * them into `node_modules` at the user's install site.
 *
 * What it does:
 *   1. Static-checks the built bundle (must be built first).
 *   2. `npm pack`s the real tarball.
 *   3. Installs the tarball into a clean temp project (production install).
 *   4. Asserts the externalized deps resolve from the installed package.
 *   5. Lists and searches tools over the installed `orc mcp` stdio server.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI_DIR = resolve(import.meta.dir, "..");
const DIST_ENTRY = join(CLI_DIR, "dist", "index.js");

// Replicates how @anthropic-ai/claude-agent-sdk locates its `claude` CLI at
// runtime: newer versions ship the binary in a platform-specific optional
// dependency package (`...-<platform>-<arch>/claude[.exe]`); older versions
// shipped a sibling `cli.js`. The fix only holds if one of these resolves from
// the installed package's own location — which is exactly what bundling broke.
function resolveSdkBinary(req: NodeRequire): string | null {
  const { platform, arch } = process;
  const exe = platform === "win32" ? ".exe" : "";
  const pkgs =
    platform === "linux"
      ? [
          `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl`,
          `@anthropic-ai/claude-agent-sdk-linux-${arch}`,
        ]
      : [`@anthropic-ai/claude-agent-sdk-${platform}-${arch}`];
  for (const p of pkgs) {
    try {
      return req.resolve(`${p}/claude${exe}`);
    } catch {
      /* try next */
    }
  }
  try {
    return req.resolve("@anthropic-ai/claude-agent-sdk/cli.js"); // legacy layout
  } catch {
    return null;
  }
}

// sqlite-vec's getLoadablePath() finds vec0 in its platform package next to its own location.
function resolveVec0(req: NodeRequire): string | null {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const ext = os === "windows" ? "dll" : os === "darwin" ? "dylib" : "so";
  try {
    return req.resolve(`sqlite-vec-${os}-${process.arch}/vec0.${ext}`);
  } catch {
    return null;
  }
}

// Deps that are intentionally external (not bundled) and therefore must be
// resolvable from the installed package's node_modules. `binary`, when set,
// resolves a runtime executable the dep loads relative to its own location.
const EXTERNAL_RUNTIME_DEPS: Array<{
  pkg: string;
  binary?: (req: NodeRequire) => string | null;
}> = [
  { pkg: "@anthropic-ai/claude-agent-sdk", binary: resolveSdkBinary },
  { pkg: "sqlite-vec", binary: resolveVec0 },
  { pkg: "zod" },
];

const failures: string[] = [];
const fail = (msg: string) => {
  failures.push(msg);
  console.error(`  ✗ ${msg}`);
};
const ok = (msg: string) => console.log(`  ✓ ${msg}`);

function run(cmd: string, args: string[], cwd: string): { code: number; stdout: string } {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: "utf-8",
    shell: process.platform === "win32",
    timeout: 240000,
  });
  if (r.error) throw r.error;
  return { code: r.status ?? 1, stdout: r.stdout ?? "" };
}

// Speaks MCP over stdio to `orc mcp`; returns the tools/list names and the tool_search text.
// The bundled CLI once served an uninitialized tool registry, so listing alone proves little.
async function probeMcp(entry: string, mode: string): Promise<{ tools: string[]; search: string }> {
  const child = spawn(process.execPath, [entry, "mcp", "--mode", mode], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const send = (msg: unknown) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  const replies = new Map<number, { result?: unknown; error?: { message: string } }>();
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (typeof msg.id === "number") replies.set(msg.id, msg);
    }
  });
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "validate", version: "0" },
    },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "tool_search", arguments: { query: "create task" } },
  });
  const deadline = Date.now() + 30000;
  try {
    while (!(replies.has(2) && replies.has(3))) {
      if (Date.now() > deadline) throw new Error("orc mcp did not answer within 30s");
      if (child.exitCode !== null) throw new Error(`orc mcp exited with code ${child.exitCode}`);
      await Bun.sleep(100);
    }
  } finally {
    child.kill();
  }
  const list = replies.get(2);
  if (list?.error) throw new Error(`tools/list failed: ${list.error.message}`);
  const call = replies.get(3);
  if (call?.error) throw new Error(`tool_search failed: ${call.error.message}`);
  const listed = (list?.result as { tools?: { name: string }[] } | undefined)?.tools ?? [];
  const tools = listed.map((t) => t.name);
  const search = (call?.result as { content?: { text?: string }[] })?.content?.[0]?.text ?? "";
  return { tools, search };
}

console.log("→ Validating orc-ai package\n");

// 1. The bundle must exist and must NOT have inlined the external SDK.
console.log("[1/4] Static bundle checks");
if (!existsSync(DIST_ENTRY)) {
  fail(`${DIST_ENTRY} missing — run \`bun run build\` first`);
} else {
  ok("dist/index.js exists");
  const bundle = readFileSync(DIST_ENTRY, "utf-8");
  // This string only lives inside the SDK; its presence means the SDK got
  // bundled instead of externalized — the exact bug we're guarding against.
  if (bundle.includes("Native CLI binary for")) {
    fail("@anthropic-ai/claude-agent-sdk appears bundled into dist/index.js (must be --external)");
  } else {
    ok("@anthropic-ai/claude-agent-sdk is not inlined into the bundle");
  }
}

// 2. Pack the real tarball.
console.log("\n[2/4] Packing tarball");
const pack = run("npm", ["pack", "--json"], CLI_DIR);
if (pack.code !== 0) {
  fail("npm pack failed");
}
let tarball = "";
try {
  tarball = JSON.parse(pack.stdout)[0]?.filename ?? "";
} catch {
  /* handled below */
}
if (!tarball) {
  fail("could not determine packed tarball filename");
} else {
  ok(`packed ${tarball}`);
}

// 3. Install into a clean temp project and assert externals resolve.
console.log("\n[3/4] Clean-install resolution checks");
let tmp = "";
if (tarball && failures.length === 0) {
  tmp = mkdtempSync(join(tmpdir(), "orc-pkg-validate-"));
  try {
    run("npm", ["init", "-y"], tmp);
    const tgz = join(CLI_DIR, tarball);
    // Production install (deps + optionalDeps, no devDeps) — mirrors a real `npm i orc-ai`.
    const install = run("npm", ["install", tgz, "--omit=dev", "--no-audit", "--no-fund"], tmp);
    if (install.code !== 0) {
      fail("npm install of tarball failed");
    } else {
      ok("tarball installs cleanly");
    }

    const installedEntry = join(tmp, "node_modules", "orc-ai", "dist", "index.js");
    if (!existsSync(installedEntry)) {
      fail("installed orc-ai is missing dist/index.js");
    } else {
      ok("installed orc-ai ships dist/index.js");
    }
    for (const name of ["orc-platform", "orc-sdlc"]) {
      const entry = join(tmp, "node_modules", "orc-ai", "dist", "skills", name, "SKILL.md");
      if (existsSync(entry)) ok(`installed package ships ${name}`);
      else fail(`installed package is missing required built-in skill ${name}`);
    }

    // Resolve each external dep the way the runtime does — from the installed
    // package's own location.
    const requireFromInstalled = createRequire(installedEntry);
    for (const { pkg, binary } of EXTERNAL_RUNTIME_DEPS) {
      try {
        requireFromInstalled.resolve(`${pkg}/package.json`);
        ok(`${pkg} resolves from the installed package`);
      } catch {
        fail(`${pkg} does NOT resolve — it must be a declared runtime dependency`);
        continue;
      }
      if (binary) {
        const binPath = binary(requireFromInstalled);
        if (binPath && existsSync(binPath)) {
          ok(`${pkg} native binary resolves (${binPath.split(/[\\/]/).slice(-2).join("/")})`);
        } else {
          fail(`${pkg} native binary does NOT resolve from the installed package`);
        }
      }
    }

    console.log("\n[4/4] Installed orc mcp (stdio)");
    if (existsSync(installedEntry)) {
      try {
        const meta = await probeMcp(installedEntry, "meta");
        if (meta.tools.join(",") === "tool_search,tool_describe,tool_invoke")
          ok("meta mode lists only the meta tools");
        else fail(`meta mode listed unexpected tools: ${meta.tools.join(", ")}`);
        if (meta.search.includes("task_create")) ok("tool_search finds task_create");
        else fail(`tool_search did not find task_create: ${meta.search.slice(0, 200)}`);
        const full = await probeMcp(installedEntry, "full");
        if (full.tools.includes("task_create") && !full.tools.includes("tool_search"))
          ok(`full mode lists ${full.tools.length} domain tools`);
        else fail(`full mode listed unexpected tools: ${full.tools.slice(0, 10).join(", ")}`);
      } catch (err) {
        fail(`orc mcp stdio probe failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(join(CLI_DIR, tarball), { force: true });
  }
} else {
  console.log("  (skipped — earlier checks failed)");
}

console.log("");
if (failures.length > 0) {
  console.error(`✗ Package validation FAILED (${failures.length} issue(s)). Do not publish.`);
  process.exit(1);
}
console.log("✓ Package validation passed — safe to publish.");
