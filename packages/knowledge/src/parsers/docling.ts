/// <reference path="../types.d.ts" />
/**
 * Optional Docling parser: a managed Python runtime the user installs from settings (never
 * shipped, never the user's own pip). Adds OCR for scans/images, PDF layout headings, structured
 * PDF tables and bbox locators. Layout:
 *   <runtime>/python/        python-build-standalone 3.12 with docling (CPU torch)
 *   <runtime>/models/        layout, tableformer, rapidocr weights (offline at parse time)
 *   <runtime>/manifest.json  written last; its presence is what "installed" means
 * ORC_DOCLING_RUNTIME points at a pre-baked runtime (e.g. a Docker image variant).
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { KbDoclingState } from "@orc/core/kb";
import script from "./docling_parse.py" with { type: "text" };

export const DOCLING_PARSER_ID = "docling";
export const DOCLING_FORMATS = ["pdf", "png", "jpg", "jpeg", "tif", "tiff", "bmp", "webp"];
/** Pinned versions measured in K01. */
export const DOCLING_PINS = {
  uv: "0.10.0",
  python: "3.12.12",
  docling: "2.140.0",
  onnxruntime: "1.31.0",
} as const;
const DOCLING_APPROX_BYTES = 2_100_000_000;

export type DoclingManifest = {
  docling: string;
  python: string;
  installed_at: number;
  size_bytes: number;
};

export function doclingRuntimeDir(root: string): string {
  return process.env.ORC_DOCLING_RUNTIME || join(root, "runtime", "docling");
}

const pythonPath = (rt: string) =>
  process.platform === "win32"
    ? join(rt, "python", "python.exe")
    : join(rt, "python", "bin", "python3");
const toolPath = (rt: string, name: string) =>
  process.platform === "win32"
    ? join(rt, "python", "Scripts", `${name}.exe`)
    : join(rt, "python", "bin", name);

export function readDoclingManifest(root: string): DoclingManifest | null {
  const rt = doclingRuntimeDir(root);
  const file = join(rt, "manifest.json");
  if (!existsSync(file) || !existsSync(pythonPath(rt))) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as DoclingManifest;
  } catch {
    return null;
  }
}

export const doclingApproxBytes = () => DOCLING_APPROX_BYTES;

function dirSize(path: string): number {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const p = join(path, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else if (entry.isFile()) total += statSync(p).size;
  }
  return total;
}

function run(
  cmd: string,
  args: string[],
  opts: { env?: Record<string, string>; log: (s: string) => void; timeoutMs: number },
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs);
    const onData = (d: Buffer) => {
      for (const line of d.toString("utf8").split(/\r?\n/))
        if (line.trim()) opts.log(line.slice(0, 300));
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${cmd.split(/[\\/]/).pop()} exited with ${signal ?? code}`));
    });
  });
}

function uvAsset(): { name: string; archive: "zip" | "tar.gz" } {
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : null;
  if (!arch)
    throw new Error(`Docling install is not supported on ${process.platform}-${process.arch}`);
  if (process.platform === "win32") return { name: `uv-${arch}-pc-windows-msvc`, archive: "zip" };
  if (process.platform === "darwin") return { name: `uv-${arch}-apple-darwin`, archive: "tar.gz" };
  if (process.platform === "linux")
    return { name: `uv-${arch}-unknown-linux-gnu`, archive: "tar.gz" };
  throw new Error(`Docling install is not supported on ${process.platform}`);
}

async function download(url: string, dest: string) {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  writeFileSync(dest, bytes);
  return bytes;
}

function findFile(dir: string, name: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return p;
    if (entry.isDirectory()) {
      const found = findFile(p, name);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Installs into <runtime>.staging and renames into place only after the parser self-test passes,
 * so a failed or interrupted install never leaves a half-working parser behind.
 */
export async function installDocling(root: string, state: KbDoclingState): Promise<void> {
  if (process.env.ORC_DOCLING_RUNTIME)
    throw new Error("ORC_DOCLING_RUNTIME is set; that runtime is managed outside ORC");
  const rt = doclingRuntimeDir(root);
  const staging = `${rt}.staging`;
  const log = (s: string) => {
    state.log.push(s);
    if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
  };
  const step = (s: string) => {
    state.step = s;
    log(`== ${s}`);
  };
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(join(staging, "tmp"), { recursive: true });
  const env = {
    UV_CACHE_DIR: join(staging, "tmp", "uv-cache"),
    UV_PYTHON_INSTALL_DIR: join(staging, "tmp", "pythons"),
    UV_NO_CONFIG: "1",
    HF_HOME: join(staging, "tmp", "hf"),
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
  };

  step("Downloading uv");
  const asset = uvAsset();
  const base = `https://github.com/astral-sh/uv/releases/download/${DOCLING_PINS.uv}/${asset.name}.${asset.archive}`;
  const archive = join(staging, "tmp", `uv.${asset.archive}`);
  const bytes = await download(base, archive);
  const expected = (
    await (await fetch(`${base}.sha256`, { signal: AbortSignal.timeout(60_000) })).text()
  )
    .trim()
    .split(/\s+/)[0];
  const actual = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  if (!expected || expected.toLowerCase() !== actual)
    throw new Error("uv download failed checksum verification");
  mkdirSync(join(staging, "tmp", "uv"), { recursive: true });
  await run("tar", ["-xf", archive, "-C", join(staging, "tmp", "uv")], { log, timeoutMs: 120_000 });
  const uv = findFile(join(staging, "tmp", "uv"), process.platform === "win32" ? "uv.exe" : "uv");
  if (!uv) throw new Error("uv binary not found in the downloaded archive");

  step(`Installing Python ${DOCLING_PINS.python}`);
  await run(
    uv,
    ["python", "install", DOCLING_PINS.python, "--install-dir", join(staging, "tmp", "pyd")],
    {
      env,
      log,
      timeoutMs: 600_000,
    },
  );
  const pyDir = readdirSync(join(staging, "tmp", "pyd")).find((d) =>
    d.startsWith(`cpython-${DOCLING_PINS.python}`),
  );
  if (!pyDir) throw new Error("Python install did not produce an interpreter");
  // A real directory, not a symlink: uv installs into relative bin paths.
  renameSync(join(staging, "tmp", "pyd", pyDir), join(staging, "python"));

  step(`Installing Docling ${DOCLING_PINS.docling} (CPU)`);
  await run(
    uv,
    [
      "pip",
      "install",
      "--python",
      pythonPath(staging),
      "--break-system-packages",
      "--torch-backend",
      "cpu",
      `docling==${DOCLING_PINS.docling}`,
      `onnxruntime==${DOCLING_PINS.onnxruntime}`,
    ],
    { env, log, timeoutMs: 1_800_000 },
  );

  step("Downloading models");
  await run(
    toolPath(staging, "docling-tools"),
    ["models", "download", "layout", "tableformer", "rapidocr", "-o", join(staging, "models")],
    { env, log, timeoutMs: 1_800_000 },
  );
  rmSync(join(staging, "tmp"), { recursive: true, force: true });

  step("Verifying");
  await run(pythonPath(staging), ["-I", "-c", "import docling, onnxruntime, rapidocr"], {
    env: offlineEnv(staging),
    log,
    timeoutMs: 300_000,
  });
  const manifest: DoclingManifest = {
    docling: DOCLING_PINS.docling,
    python: DOCLING_PINS.python,
    installed_at: Date.now(),
    size_bytes: dirSize(staging),
  };
  writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));
  rmSync(rt, { recursive: true, force: true });
  renameSync(staging, rt);
  step("Installed");
}

export function uninstallDocling(root: string) {
  if (process.env.ORC_DOCLING_RUNTIME)
    throw new Error("ORC_DOCLING_RUNTIME is set; that runtime is managed outside ORC");
  const rt = doclingRuntimeDir(root);
  rmSync(rt, { recursive: true, force: true });
  rmSync(`${rt}.staging`, { recursive: true, force: true });
}

const offlineEnv = (rt: string): Record<string, string> => ({
  HF_HUB_OFFLINE: "1",
  TRANSFORMERS_OFFLINE: "1",
  HF_HOME: join(rt, "models", ".hf"),
  PYTHONIOENCODING: "utf-8",
  PYTHONUTF8: "1",
  OMP_NUM_THREADS: "4",
});

/**
 * Command for one Docling job; the registry owns spawning, timeouts and validation. The adapter
 * script always comes from this ORC build, so it matches the ParsedDocument schema it validates.
 */
export function doclingCommand(
  root: string,
  input: string,
  output: string,
): { cmd: string[]; env: Record<string, string> } {
  const rt = doclingRuntimeDir(root);
  const scriptPath = join(root, "runtime", "docling_parse.py");
  mkdirSync(join(root, "runtime"), { recursive: true });
  if (!existsSync(scriptPath) || readFileSync(scriptPath, "utf8") !== script)
    writeFileSync(scriptPath, script);
  return {
    cmd: [pythonPath(rt), "-I", scriptPath, input, output, join(rt, "models")],
    env: offlineEnv(rt),
  };
}
