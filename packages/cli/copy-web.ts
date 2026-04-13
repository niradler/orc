import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const src = join(import.meta.dir, "..", "web", "dist");
const dest = join(import.meta.dir, "dist", "web");

if (!existsSync(join(src, "index.html"))) {
  console.error(`Web dist not found at ${src}. Run 'bun run build:web' first.`);
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`Copied ${src} → ${dest}`);
