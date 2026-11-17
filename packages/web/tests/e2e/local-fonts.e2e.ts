import { expect, test } from "@playwright/test";
import { gotoView } from "./_helpers";

test("should load the existing UI and code fonts from the app origin", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await gotoView(page, "sessions");
  const faces = await page.evaluate(async () => {
    const loaded = await Promise.all(
      [
        '400 14px "Inter Variable"',
        '600 14px "Inter Variable"',
        '400 14px "Geist Variable"',
        '600 14px "Geist Variable"',
        '400 14px "IBM Plex Mono"',
        '500 14px "IBM Plex Mono"',
      ].map((font) => document.fonts.load(font)),
    );
    return loaded.map((fonts) => fonts.map((font) => font.status));
  });
  for (const fonts of faces) {
    expect(fonts.length).toBeGreaterThan(0);
    expect(fonts.every((status) => status === "loaded")).toBe(true);
  }
  expect(requests.some((url) => /fonts\.(googleapis|gstatic)\.com/.test(url))).toBe(false);
  const fonts = requests.filter((url) => /\.woff2(?:\?|$)/.test(url));
  expect(fonts.length).toBeGreaterThanOrEqual(4);
  for (const font of fonts) expect(new URL(font).origin).toBe(new URL(page.url()).origin);
  for (const family of ["inter", "geist", "ibm-plex-mono"]) {
    const license = await page.request.get(`/${family}-LICENSE.txt`);
    expect(license.ok()).toBe(true);
    expect(await license.text()).toContain("SIL OPEN FONT LICENSE Version 1.1");
  }
});
