import { writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";

/** Keep actual source state beside review images rather than reconstructing it later. */
export async function captureState(page: Page, options: Parameters<Page["screenshot"]>[0]) {
  const metadata = {
    sourceURL: page.url(),
    capturedAt: new Date().toISOString(),
    viewport: page.viewportSize(),
    theme: await page.locator("html").getAttribute("data-theme"),
    state: options?.path?.split(/[\\/]/).at(-1),
  };
  const result = await page.screenshot(options);
  if (options?.path) writeFileSync(`${options.path}.json`, JSON.stringify(metadata, null, 2));
  return result;
}
