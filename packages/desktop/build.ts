import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = import.meta.dirname;
await mkdir(resolve(root, "dist"), { recursive: true });
for (const [entry, target, format, name] of [
  ["main.ts", "node", "esm", "main.js"],
  ["preload.ts", "node", "cjs", "preload.cjs"],
  ["viewer-preload.ts", "node", "cjs", "viewer-preload.cjs"],
  ["viewer-renderer.ts", "browser", "iife", "viewer-renderer.js"],
] as const) {
  const result = await Bun.build({
    entrypoints: [resolve(root, "src", entry)],
    outdir: resolve(root, "dist"),
    naming: name,
    target,
    format,
    external: ["electron", "electron-updater"],
  });
  if (!result.success) throw new AggregateError(result.logs, `Could not bundle ${entry}`);
}
for (const file of ["viewer.html", "viewer.css"]) {
  await copyFile(resolve(root, "src", file), resolve(root, "dist", file));
}
