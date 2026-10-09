#!/usr/bin/env bun
import { installEmbeddedSkills } from "../../core/src/builtin-skills.js";
import { SKILL_ASSETS } from "./_skills-manifest.generated.js";
/**
 * Entry point for standalone compiled binaries (`bun build --compile`).
 *
 * Loads the generated web-asset manifest (embedded via Bun's `{ type: "file" }`
 * imports) and registers them on `globalThis` so the API's static-file middleware
 * can serve the dashboard without a filesystem `dist/web/` directory.
 *
 * For the npm-published package and dev mode the normal `src/index.ts` entry is
 * used instead - it relies on the filesystem copy in `dist/web/`.
 */
import { WEB_ASSETS } from "./_web-manifest.generated.js";

// Same structural shape the API's static middleware reads (packages/api/src/static.ts).
(globalThis as { __ORC_EMBEDDED_WEB__?: typeof WEB_ASSETS }).__ORC_EMBEDDED_WEB__ = WEB_ASSETS;
(globalThis as { __ORC_BUILTIN_SKILLS_DIR__?: string }).__ORC_BUILTIN_SKILLS_DIR__ =
  installEmbeddedSkills(SKILL_ASSETS);

await import("./index.js");
