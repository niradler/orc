/**
 * Fetches the sqlite-vec loadable extension for a compile target so the standalone binary can
 * embed it. The platform package version and its sha512 integrity come from bun.lock, so the
 * bytes are the ones a source install of @orc/knowledge would load.
 * Output: packages/cli/dist/native/<platform>/vec0.<ext>
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const CLI = join(import.meta.dir, "..");

/** bun compile target (bun-linux-x64) -> sqlite-vec platform suffix and library extension. */
export function vec0Platform(target: string): { platform: string; ext: string } {
  const [, os, arch] = target.split("-");
  if (!os || !arch) throw new Error(`Unexpected compile target ${target}`);
  const ext = os === "windows" ? "dll" : os === "darwin" ? "dylib" : "so";
  return { platform: `${os}-${arch}`, ext };
}

function lockEntry(pkg: string): { version: string; integrity: string } {
  const lock = readFileSync(join(ROOT, "bun.lock"), "utf8");
  const match = lock.match(
    new RegExp(`"${pkg}": \\["${pkg}@([^"]+)", "[^"]*", \\{[^}]*\\}, "(sha512-[^"]+)"\\]`),
  );
  if (!match?.[1] || !match[2]) throw new Error(`${pkg} is not pinned in bun.lock`);
  return { version: match[1], integrity: match[2] };
}

/** Reads one file out of an uncompressed tar archive. */
function untarFile(tar: Uint8Array, name: string): Uint8Array | null {
  const decoder = new TextDecoder();
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const entry = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/s, "");
    const size = Number.parseInt(decoder.decode(header.subarray(124, 136)).trim() || "0", 8);
    const start = offset + 512;
    if (entry === name) return tar.slice(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
  }
  return null;
}

export async function fetchVec0(target: string): Promise<string> {
  const { platform, ext } = vec0Platform(target);
  const pkg = `sqlite-vec-${platform}`;
  const { version, integrity } = lockEntry(pkg);
  const outDir = join(CLI, "dist", "native", platform);
  const out = join(outDir, `vec0.${ext}`);
  const stamp = join(outDir, "integrity");
  if (existsSync(out) && existsSync(stamp) && readFileSync(stamp, "utf8") === integrity) return out;

  const url = `https://registry.npmjs.org/${pkg}/-/${pkg}-${version}.tgz`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${url} (${res.status})`);
  const tgz = new Uint8Array(await res.arrayBuffer());
  const actual = `sha512-${createHash("sha512").update(tgz).digest("base64")}`;
  if (actual !== integrity) throw new Error(`${pkg}@${version} failed integrity verification`);
  const lib = untarFile(Bun.gunzipSync(tgz), `package/vec0.${ext}`);
  if (!lib) throw new Error(`${pkg}@${version} has no vec0.${ext}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(out, lib);
  writeFileSync(stamp, integrity);
  return out;
}
