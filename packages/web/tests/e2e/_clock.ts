import type { Page } from "@playwright/test";

export async function pauseBrowserClock(page: Page): Promise<void> {
  const origin = Date.now();
  await page.clock.install({ time: origin });
  // Keep the pause target ahead throughout the bounded test, including slow browser RPCs.
  await page.clock.pauseAt(origin + 60_000);
}
