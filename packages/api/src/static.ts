import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type { Context, MiddlewareHandler } from "hono";

// Embedded web assets — set by standalone binary entry (bin-entry.ts).
// Maps URL path (e.g. "index.html", "assets/foo.js") → $bunfs embedded path.
const embeddedWeb: Record<string, string> | null = (globalThis as any).__ORC_EMBEDDED_WEB__ ?? null;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

const moduleDir = dirname(fileURLToPath(import.meta.url));
// For `bun build --compile` standalone binaries, `import.meta.url` points at an
// embedded virtual FS (e.g. `$bunfs/root/...`), and `process.argv[0]` is just
// the string `"bun"`. Only `process.execPath` resolves to the real on-disk
// executable path — use it so bundled `./web` alongside the exe is discoverable.
const execDir = process.execPath ? dirname(process.execPath) : moduleDir;

// Candidate dist locations — first existing wins.
// 1. Source dev / workspace install: packages/api/src → packages/web/dist
// 2. Bundled CLI (packages/cli/dist/index.js): dist/web (copied by CLI build)
// 3. Sibling install layout
// 4. Standalone binary: ./web relative to the exe on disk
const CANDIDATES = [
  resolve(moduleDir, "../../web/dist"),
  resolve(moduleDir, "./web"),
  resolve(moduleDir, "../web"),
  resolve(moduleDir, "../../web"),
  resolve(execDir, "./web"),
  resolve(execDir, "../web"),
];

function resolveWebDist(): string | null {
  const override = process.env.ORC_WEB_DIST;
  if (override && existsSync(join(override, "index.html"))) return override;
  for (const dir of CANDIDATES) {
    if (existsSync(join(dir, "index.html"))) return dir;
  }
  return null;
}

function guessContentType(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function isSafeChild(base: string, target: string): boolean {
  const rel = resolve(base, target);
  return rel === base || rel.startsWith(`${base}${process.platform === "win32" ? "\\" : "/"}`);
}

async function sendFile(_c: Context, filePath: string, cacheable: boolean): Promise<Response> {
  const file = Bun.file(filePath);
  const headers: Record<string, string> = {
    "Content-Type": guessContentType(filePath),
  };
  if (cacheable) headers["Cache-Control"] = "public, max-age=31536000, immutable";
  else headers["Cache-Control"] = "no-cache";
  return new Response(file, { headers });
}

/**
 * Serves the built web dashboard from `packages/web/dist` (or an equivalent
 * bundled location). Mount LAST in the route chain — it only responds to GET/
 * HEAD requests that don't match any API route, and always falls back to
 * `index.html` for the root path so the single-page app can bootstrap.
 *
 * Returns a no-op middleware if no dist directory is found, letting the server
 * run in pure-API mode during development before a web build has been produced.
 */
function sendEmbedded(_c: Context, bunfsPath: string, cacheable: boolean): Response {
  const file = Bun.file(bunfsPath);
  const headers: Record<string, string> = {
    "Content-Type": guessContentType(bunfsPath),
  };
  if (cacheable) headers["Cache-Control"] = "public, max-age=31536000, immutable";
  else headers["Cache-Control"] = "no-cache";
  return new Response(file, { headers });
}

export function createWebStatic(): MiddlewareHandler {
  const dist = resolveWebDist();

  // No filesystem dist AND no embedded assets → pure-API mode.
  if (!dist && !embeddedWeb) {
    return async (_c, next) => {
      await next();
    };
  }

  // Precompute which files exist under /assets/ to avoid stat calls per request.
  const assetsDir = dist ? join(dist, "assets") : null;
  const assetFiles = new Set<string>();
  if (assetsDir && existsSync(assetsDir)) {
    for (const name of readdirSync(assetsDir)) {
      if (statSync(join(assetsDir, name)).isFile()) assetFiles.add(name);
    }
  }
  const indexHtml = dist ? join(dist, "index.html") : null;

  return async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      await next();
      return;
    }
    const url = new URL(c.req.url);
    const path = decodeURIComponent(url.pathname);

    // --- index.html ---
    if (path === "/" || path === "/index.html") {
      if (indexHtml) return sendFile(c, indexHtml, false);
      if (embeddedWeb?.["index.html"]) return sendEmbedded(c, embeddedWeb["index.html"], false);
      await next();
      return;
    }

    // --- /assets/* ---
    if (path.startsWith("/assets/")) {
      const name = path.slice("/assets/".length);
      // Filesystem first
      if (assetsDir && assetFiles.has(name)) {
        const filePath = join(assetsDir, name);
        if (isSafeChild(assetsDir, filePath)) return sendFile(c, filePath, true);
      }
      // Embedded fallback
      const key = `assets/${name}`;
      if (embeddedWeb?.[key]) return sendEmbedded(c, embeddedWeb[key], true);
      await next();
      return;
    }

    // --- Root-level public files (favicon, robots, etc.) ---
    const topLevel = path.replace(/^\//, "");
    if (topLevel && !topLevel.includes("/")) {
      // Filesystem first
      if (dist) {
        const candidate = join(dist, topLevel);
        if (isSafeChild(dist, candidate) && existsSync(candidate) && statSync(candidate).isFile()) {
          return sendFile(c, candidate, false);
        }
      }
      // Embedded fallback
      if (embeddedWeb?.[topLevel]) return sendEmbedded(c, embeddedWeb[topLevel], false);
    }

    await next();
  };
}

export { resolveWebDist };
