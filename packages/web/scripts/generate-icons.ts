// Renders the PWA/home-screen PNG icons from public/favicon.svg.
// Run after changing the logo: bun packages/web/scripts/generate-icons.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const publicDir = join(import.meta.dir, "..", "public");
const logo = readFileSync(join(publicDir, "favicon.svg"), "utf8");
// Full-bleed variant: launchers (Android maskable, iOS) apply their own shape, so no rounded corners.
const fullBleed = logo.replace(
  /<rect [^>]*\/>/,
  '<rect width="1024" height="1024" fill="#000000"/>',
);

// Android status-bar badge: a white glyph on transparency.
const badge = logo.replace(/<rect [^>]*\/>/, "").replaceAll("#E5E5E5", "#FFFFFF");

const icons = [
  { file: "icon-192.png", size: 192, svg: logo },
  { file: "icon-512.png", size: 512, svg: logo },
  { file: "icon-maskable-512.png", size: 512, svg: fullBleed },
  { file: "apple-touch-icon.png", size: 180, svg: fullBleed },
  { file: "badge-96.png", size: 96, svg: badge },
];

const browser = await chromium.launch();
try {
  for (const icon of icons) {
    const page = await browser.newPage({ viewport: { width: icon.size, height: icon.size } });
    const svg = icon.svg.replace(
      /width="1024" height="1024"/,
      `width="${icon.size}" height="${icon.size}"`,
    );
    await page.setContent(
      `<html><body style="margin:0;background:transparent">${svg}</body></html>`,
    );
    await page.screenshot({ path: join(publicDir, icon.file), omitBackground: true });
    await page.close();
    console.log(`wrote ${icon.file}`);
  }
} finally {
  await browser.close();
}
