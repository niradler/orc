import { readFileSync } from "node:fs";
import { expect, type Page, type TestInfo } from "@playwright/test";

// Exercise the published agent skeleton, not a hand-maintained copy of the kit markup.
const reference = readFileSync(
  new URL("../../../../skills/orc-platform/references/html-kit.md", import.meta.url),
  "utf8",
);
const skeleton = reference.match(/```html\n(<!doctype[\s\S]*?)\n```/)?.[1];
if (!skeleton) throw new Error("HTML kit skill skeleton missing");

export const HTML_KIT_EXAMPLE = skeleton
  .replace('data-orc-panel="p1"', 'data-orc-panel="p1" data-testid="kit-now"')
  .replace('data-orc-panel="p2"', 'data-orc-panel="p2" data-testid="kit-next"')
  .replace('id="p1"', 'id="p1" data-testid="kit-panel-now"')
  .replace('id="p2"', 'id="p2" data-testid="kit-panel-next"')
  .replace(
    "</body>",
    `<div class="orc-tabs">
      <div role="tablist" aria-label="Fallback selection" aria-orientation="vertical">
        <button disabled aria-selected="true" data-orc-tab data-orc-panel="fallback-disabled" data-testid="kit-fallback-disabled">Unavailable</button>
        <button data-orc-tab data-orc-panel="fallback-first" data-testid="kit-fallback-first">First</button>
        <button data-orc-tab data-orc-panel="fallback-last" data-testid="kit-fallback-last">Last</button>
      </div>
      <div class="orc-tab-panel" id="fallback-disabled" data-testid="kit-fallback-panel-disabled">Unavailable panel</div>
      <div class="orc-tab-panel" id="fallback-first" data-testid="kit-fallback-panel-first">First panel</div>
      <div class="orc-tab-panel" id="fallback-last" data-testid="kit-fallback-panel-last">Last panel</div>
    </div></body>`,
  );

export async function checkHtmlKit(page: Page, frameTestId: string, info: TestInfo): Promise<void> {
  const iframe = page.getByTestId(frameTestId);
  const frame = page.frameLocator(`[data-testid="${frameTestId}"]`);
  const now = frame.getByTestId("kit-now");
  const next = frame.getByTestId("kit-next");
  const panelNow = frame.getByTestId("kit-panel-now");
  const panelNext = frame.getByTestId("kit-panel-next");
  await expect(iframe).not.toHaveAttribute("sandbox", /allow-same-origin/);

  // The real header updates useTheme subscribers in both iframe callers, without a reload.
  for (let pass = 0; pass < 2; pass++) {
    await expect(panelNow).toBeVisible();
    await expect(panelNext).toBeHidden();
    await expect(now).toHaveAttribute("tabindex", "0");
    await expect(next).toHaveAttribute("tabindex", "-1");
    if ((page.viewportSize()?.width ?? 1280) < 640) {
      expect(
        await now.evaluate((tab) => tab.getBoundingClientRect().height),
      ).toBeGreaterThanOrEqual(44);
      expect(
        await next.evaluate((tab) => tab.getBoundingClientRect().height),
      ).toBeGreaterThanOrEqual(44);
    }
    await expect(frame.getByTestId("kit-fallback-first")).toHaveAttribute("aria-selected", "true");
    await expect(frame.getByTestId("kit-fallback-panel-first")).toBeVisible();
    await expect(frame.getByTestId("kit-fallback-panel-last")).toBeHidden();
    await expect(frame.getByTestId("kit-fallback-panel-disabled")).toBeHidden();
    await expect(frame.getByTestId("kit-fallback-disabled")).toHaveAttribute("tabindex", "-1");

    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    const background = theme === "light" ? "rgb(250, 250, 250)" : "rgb(0, 0, 0)";
    await expect(panelNow).toHaveCSS(
      "color",
      theme === "light" ? "rgb(37, 38, 42)" : "rgb(229, 229, 229)",
    );
    const contentFrame = await (await iframe.elementHandle())?.contentFrame();
    if (!contentFrame) throw new Error("Kit iframe missing");
    expect(await contentFrame.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
      background,
    );
    expect(
      await contentFrame.evaluate(() => document.querySelectorAll("style#orc-kit").length),
    ).toBe(1);
    expect(
      await contentFrame.evaluate(() =>
        document.querySelector("style#orc-kit")?.getAttribute("data-orc-kit-version"),
      ),
    ).toBe("1");
    expect(
      await contentFrame.evaluate(() => {
        let parentBlocked = false;
        let storageBlocked = false;
        try {
          void parent.document.body;
        } catch {
          parentBlocked = true;
        }
        try {
          void localStorage.length;
        } catch {
          storageBlocked = true;
        }
        return { parentBlocked, storageBlocked, bridgeAbsent: !("orc" in window) };
      }),
    ).toEqual({ parentBlocked: true, storageBlocked: true, bridgeAbsent: true });

    await next.click();
    await expect(panelNow).toBeHidden();
    await expect(panelNext).toBeVisible();
    await next.press("ArrowLeft");
    await expect(now).toBeFocused();
    await expect(panelNow).toBeVisible();
    await expect(panelNext).toBeHidden();
    await now.press("ArrowLeft");
    await expect(next).toBeFocused();
    await expect(panelNow).toBeHidden();
    await expect(panelNext).toBeVisible();
    await next.press("ArrowRight");
    await expect(now).toBeFocused();
    await now.press("End");
    await expect(next).toBeFocused();
    await expect(panelNext).toBeVisible();
    await next.press("Home");
    await expect(now).toBeFocused();
    await expect(now).toHaveAttribute("aria-selected", "true");
    await expect(next).toHaveAttribute("aria-selected", "false");
    await expect(panelNow).toBeVisible();
    await expect(panelNext).toBeHidden();

    // Independent tab groups must not change each other's selection or visibility.
    await frame.getByTestId("kit-fallback-last").click();
    await expect(frame.getByTestId("kit-fallback-panel-first")).toBeHidden();
    await expect(frame.getByTestId("kit-fallback-panel-last")).toBeVisible();
    await expect(panelNow).toBeVisible();
    await frame.getByTestId("kit-fallback-last").press("ArrowDown");
    await expect(frame.getByTestId("kit-fallback-first")).toBeFocused();
    await frame.getByTestId("kit-fallback-first").press("ArrowUp");
    await expect(frame.getByTestId("kit-fallback-last")).toBeFocused();
    await contentFrame.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: info.outputPath(`${frameTestId}-${theme}.png`) });
    if (pass === 0) {
      if (await page.getByTestId("theme-toggle").isVisible()) {
        await page.getByTestId("theme-toggle").click();
      } else {
        // Fullscreen chat hides the header. Exercise the real cross-tab theme subscription
        // while keeping the chat artifact mounted, as when another ORC tab changes theme.
        await page.evaluate(
          (nextTheme) => {
            localStorage.setItem("orc_theme", nextTheme);
            window.dispatchEvent(
              new StorageEvent("storage", { key: "orc_theme", newValue: nextTheme }),
            );
          },
          theme === "light" ? "dark" : "light",
        );
      }
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
        .not.toBe(theme);
      await expect
        .poll(() =>
          contentFrame
            .evaluate(() => getComputedStyle(document.body).backgroundColor)
            .catch(() => "reloading"),
        )
        .not.toBe(background);
    }
  }
}
