import { expect, test } from "@playwright/test";
import { gotoView } from "./_helpers";

const viewports = [1440, 390, 320].flatMap((width) =>
  [650, 844].map((height) => ({ width, height })),
);
viewports.push({ width: 844, height: 390 });

for (const viewport of viewports) {
  test(`a short scratchpad form anchors aligned actions to the dialog bottom at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await gotoView(page, "scratchpads");
    await page.getByTestId("new-scratchpad-button").click();
    const dialog = page.getByTestId("scratchpad-form");
    await expect(dialog).toBeVisible();
    const geometry = await dialog.evaluate((element) => {
      const footer = element.querySelector(".work-form-footer");
      const body = element.querySelector(".work-form-body");
      if (!footer || !body) throw new Error("Missing shared form body or footer");
      const bounds = element.getBoundingClientRect();
      const actions = footer.getBoundingClientRect();
      const buttons = [...footer.querySelectorAll("button")].map((button) => {
        const box = button.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, center: box.top + box.height / 2 };
      });
      return {
        dialogBottom: bounds.bottom,
        dialogTop: bounds.top,
        footerBottom: actions.bottom,
        footerTop: actions.top,
        border: Number.parseFloat(getComputedStyle(element).borderBottomWidth),
        bodyBottom: body.getBoundingClientRect().bottom,
        buttons,
      };
    });
    expect(geometry.footerBottom).toBeCloseTo(geometry.dialogBottom - geometry.border, 0);
    expect(geometry.footerTop).toBeGreaterThan(geometry.dialogTop);
    expect(geometry.footerBottom).toBeLessThanOrEqual(viewport.height + 1);
    expect(geometry.bodyBottom).toBeCloseTo(geometry.footerTop, 0);
    expect(geometry.buttons).toHaveLength(2);
    expect(geometry.buttons[0].center).toBeCloseTo(geometry.buttons[1].center, 1);
    for (const button of geometry.buttons) {
      expect(button.top).toBeGreaterThanOrEqual(geometry.footerTop);
      expect(button.bottom).toBeLessThanOrEqual(geometry.footerBottom);
    }
    const scroll = await dialog.locator(".work-form-body").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return { actual: element.scrollTop, expected: element.scrollHeight - element.clientHeight };
    });
    expect(scroll.actual).toBeCloseTo(scroll.expected, 0);
    await expect(dialog.getByTestId("scratchpad-form-submit")).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`scratchpad-footer-${viewport.width}x${viewport.height}.png`),
      animations: "disabled",
    });
  });
}
