import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context, MiddlewareHandler } from "hono";

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

// Candidate dist locations — first existing wins.
// 1. Source dev / workspace install: packages/api/src → packages/web/dist
// 2. Bundled CLI (packages/cli/dist/index.js): dist/web (copied by CLI build)
// 3. Sibling install layout
const CANDIDATES = [
  resolve(moduleDir, "../../web/dist"),
  resolve(moduleDir, "./web"),
  resolve(moduleDir, "../web"),
  resolve(moduleDir, "../../web"),
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

async function sendFile(c: Context, filePath: string, cacheable: boolean): Promise<Response> {
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
export function createWebStatic(): MiddlewareHandler {
  const dist = resolveWebDist();
  if (!dist) {
    return async (_c, next) => {
      await next();
    };
  }

  // Precompute which files exist under /assets/ to avoid stat calls per request.
  const assetsDir = join(dist, "assets");
  const assetFiles = new Set<string>();
  if (existsSync(assetsDir)) {
    for (const name of readdirSync(assetsDir)) {
      if (statSync(join(assetsDir, name)).isFile()) assetFiles.add(name);
    }
  }
  const indexHtml = join(dist, "index.html");

  return async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      await next();
      return;
    }
    const url = new URL(c.req.url);
    const path = decodeURIComponent(url.pathname);

    if (path === "/" || path === "/index.html") {
      return sendFile(c, indexHtml, false);
    }

    if (path.startsWith("/assets/")) {
      const name = path.slice("/assets/".length);
      if (assetFiles.has(name)) {
        const filePath = join(assetsDir, name);
        if (isSafeChild(assetsDir, filePath)) return sendFile(c, filePath, true);
      }
      await next();
      return;
    }

    // Root-level public files (favicon, robots, etc.)
    const topLevel = path.replace(/^\//, "");
    if (topLevel && !topLevel.includes("/")) {
      const candidate = join(dist, topLevel);
      if (isSafeChild(dist, candidate) && existsSync(candidate) && statSync(candidate).isFile()) {
        return sendFile(c, candidate, false);
      }
    }

    await next();
  };
}

export { resolveWebDist };
