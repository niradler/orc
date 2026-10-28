import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** Where the diagram editor tells Excalidraw to load its fonts from (EXCALIDRAW_ASSET_PATH). */
const EXCALIDRAW_ASSETS = "assets/excalidraw/";
// Xiaolai covers CJK in 13MB of unicode-range chunks; Excalidraw falls back to its CDN for it.
const SKIPPED_FONTS = new Set(["Xiaolai"]);

/**
 * Serves Excalidraw's fonts from the app origin, like the UI fonts, so diagrams render offline
 * and without third-party requests. Under /assets/ the service worker caches them.
 */
function excalidrawFonts(): Plugin {
  // The package's default export is dist/prod/index.js; its fonts sit beside it.
  const fontsDir = path.join(
    path.dirname(createRequire(import.meta.url).resolve("@excalidraw/excalidraw")),
    "fonts",
  );
  const files = () =>
    readdirSync(fontsDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && !SKIPPED_FONTS.has(path.basename(entry.parentPath)))
      .map((entry) => path.relative(fontsDir, path.join(entry.parentPath, entry.name)));
  const prefix = `/${EXCALIDRAW_ASSETS}fonts/`;
  return {
    name: "orc-excalidraw-fonts",
    configureServer(server) {
      const served = new Set(files().map((file) => file.split(path.sep).join("/")));
      server.middlewares.use((req, res, next) => {
        const file =
          req.url?.startsWith(prefix) && decodeURIComponent(req.url.slice(prefix.length));
        if (!file || !served.has(file)) return next();
        res.setHeader("Content-Type", "font/woff2");
        res.end(readFileSync(path.join(fontsDir, file)));
      });
    },
    generateBundle() {
      for (const file of files())
        this.emitFile({
          type: "asset",
          fileName: `${EXCALIDRAW_ASSETS}fonts/${file.split(path.sep).join("/")}`,
          source: readFileSync(path.join(fontsDir, file)),
        });
    },
  };
}

export default defineConfig({
  plugins: [react(), excalidrawFonts()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    port: Number(process.env.ORC_WEB_PORT) || 9742,
    proxy: {
      "/webhooks/": {
        target: `http://localhost:${process.env.ORC_API_PORT ?? 7701}`,
        changeOrigin: true,
      },
      "/api": {
        target: `http://localhost:${process.env.ORC_API_PORT ?? 7701}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
