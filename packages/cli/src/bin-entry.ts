#!/usr/bin/env bun
/**
 * Entry point for standalone compiled binaries (`bun build --compile`).
 *
 * Loads the generated web-asset manifest (embedded via Bun's `{ type: "file" }`
 * imports) and registers them on `globalThis` so the API's static-file middleware
 * can serve the dashboard without a filesystem `dist/web/` directory.
 *
 * For the npm-published package and dev mode the normal `src/index.ts` entry is
 * used instead — it relies on the filesystem copy in `dist/web/`.
 */
import { WEB_ASSETS } from "./_web-manifest.generated.js";

(globalThis as any).__ORC_EMBEDDED_WEB__ = WEB_ASSETS;

await import("./index.js");
