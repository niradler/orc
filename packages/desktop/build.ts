import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = import.meta.dirname;
await mkdir(resolve(root, "dist"), { recursive: true });
for (const [entry, target, format, name] of [
  ["main.ts", "node", "esm", "main.js"],
  ["preload.ts", "node", "cjs", "preload.cjs"],
  ["preview-guest-preload.ts", "node", "cjs", "preview-guest-preload.cjs"],
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
