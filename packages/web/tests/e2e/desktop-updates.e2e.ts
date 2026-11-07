import { expect, test } from "@playwright/test";
import { API_SECRET } from "./_helpers";

for (const width of [1440, 390]) {
  test(`desktop update settings and failures at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript((secret) => {
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
      const state = {
        currentVersion: "0.1.60",
        channel: "stable",
        checksEnabled: true,
        phase: "downloaded",
        availableVersion: "0.1.61",
        releaseNotes: "Improved session recovery and desktop reliability.",
        progress: 100,
        lastCheckedAt: "2026-11-07T12:00:00.000Z",
        error: null,
        packaged: true,
      };
      Object.defineProperty(window, "orcDesktop", {
        value: {
          notify: () => {},
          onOpen: () => () => {},
          updates: {
            state: async () => state,
            onChange: () => () => {},
            setPreferences: async () => {
              throw new Error("Fixture settings write failed");
            },
            check: async () => {
              throw new Error("Fixture update check failed");
            },
            install: async () => {
              throw new Error("Fixture install failed");
            },
          },
        },
      });
    }, API_SECRET);
    await page.route("**/api/system/about", (route) =>
      route.fulfill({
        json: {
          version: "0.1.60",
          platform: "win32",
          os_release: "Windows 11",
          arch: "x64",
          runtime: "Bun 1.4.4",
          data_dir: "C:/Demo/orc",
          instance_id: "demo-desktop",
        },
      }),
    );
    await page.goto("/settings?settingsSection=about");
    const section = page.getByTestId("settings-about");
    await expect(page.getByTestId("about-update-install")).toBeVisible();
    await expect(page.getByTestId("about-update-notes")).toContainText("Improved session");
    expect(await section.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await section.screenshot({ path: testInfo.outputPath(`desktop-updates-${width}.png`) });
    await page.getByTestId("about-update-checks").click();
    await expect(page.getByTestId("about-update-error")).toBeVisible();
    await expect(page.getByTestId("about-update-checks")).toBeChecked();
    await page.getByTestId("about-update-check").click();
    await expect(page.getByTestId("about-update-error")).toBeVisible();
    await page.getByTestId("about-update-install").click();
    await expect(page.getByTestId("about-update-error")).toBeVisible();
  });
}
