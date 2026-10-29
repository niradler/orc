import { expect, type Locator, test } from "@playwright/test";
import { API_SECRET, apiPost, gotoView, tid } from "./_helpers";

async function nativeChevron(control: Locator) {
  const style = await control.evaluate((element) => {
    const css = getComputedStyle(element);
    return {
      appearance: css.appearance,
      image: decodeURIComponent(css.backgroundImage),
      size: css.backgroundSize,
      position: css.backgroundPosition,
      padding: css.paddingInlineEnd,
    };
  });
  expect(style.appearance).toBe("none");
  expect(style.image).toContain("stroke-width='1.5'");
  expect(style.image).toContain("m6 9 6 6 6-6");
  expect(style.size).toBe("14px 14px");
  expect(style.position).toContain("12px");
  expect(style.padding).toBe("36px");
  return style.image;
}

for (const theme of ["dark", "light"] as const) {
  for (const width of [1440, 390]) {
    test(`dropdown chevrons align without hiding labels or changing keyboard selection ${theme} ${width}`, async ({
      page,
      request,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.request.patch("/api/settings", {
        headers: { Authorization: `Bearer ${API_SECRET}` },
        data: { theme },
      });
      await page.addInitScript((theme) => localStorage.setItem("orc_theme", theme), theme);
      const longName = `${tid("long-project")}-${"selected-project-label-".repeat(6)}`.slice(
        0,
        100,
      );
      await apiPost(request, "/projects", { name: longName });
      await gotoView(page, "jobs");
      await page.getByTestId("new-job-button").click();
      const action = page.getByTestId("job-action-type");
      const trigger = page.getByTestId("job-trigger-type");
      const nativeImage = await nativeChevron(action);
      await action.focus();
      await action.press("End");
      await expect(action).toHaveValue("task");
      await action.press("Home");
      await expect(action).toHaveValue("command");
      await trigger.focus();
      await trigger.press("Space");
      await expect(page.getByTestId("job-trigger-manual")).toBeFocused();
      await page.keyboard.press("c");
      await expect(page.getByTestId("job-trigger-cron")).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(trigger).toContainText("cron");

      const projectChoice = page.getByTestId("job-project-select");
      await projectChoice.click();
      await page.getByRole("option", { name: longName, exact: true }).click();
      await expect(projectChoice).toContainText(longName);
      const geometry = await projectChoice.evaluate((element) => {
        const control = element.getBoundingClientRect();
        const svg = element.querySelector("svg");
        const text = element.querySelector(":scope > span");
        if (!svg || !text) throw new Error("Missing select text or chevron");
        const icon = svg.getBoundingClientRect();
        const label = text.getBoundingClientRect();
        return {
          size: [icon.width, icon.height],
          right: control.right - icon.right,
          center: icon.y + icon.height / 2 - (control.y + control.height / 2),
          stroke: svg.getAttribute("stroke-width"),
          path: svg.querySelector("path")?.getAttribute("d"),
          color: getComputedStyle(svg).color,
          labelRight: label.right,
          iconLeft: icon.left,
          labelOverflow: getComputedStyle(text).textOverflow,
        };
      });
      expect(geometry.size).toEqual([14, 14]);
      expect(geometry.right).toBeCloseTo(13, 0);
      expect(geometry.center).toBeCloseTo(0, 1);
      expect(geometry.stroke).toBe("1.5");
      expect(geometry.path).toBe("m6 9 6 6 6-6");
      expect(geometry.labelRight).toBeLessThanOrEqual(geometry.iconLeft - 1);
      expect(geometry.labelOverflow).toBe("ellipsis");
      const nativeColor = await page.evaluate((image) => {
        const color = image.match(/stroke=['"]([^'"]+)['"]/)?.[1];
        if (!color) throw new Error("Missing native chevron stroke");
        const probe = document.createElement("span");
        probe.style.color = color;
        document.body.append(probe);
        const computed = getComputedStyle(probe).color;
        probe.remove();
        return computed;
      }, nativeImage);
      expect(nativeColor).toBe(geometry.color);
      await action.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: testInfo.outputPath(`job-dropdowns-${theme}-${width}.png`),
        animations: "disabled",
      });
      await projectChoice.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: testInfo.outputPath(`long-project-${theme}-${width}.png`),
        animations: "disabled",
      });
      await page.keyboard.press("Escape");
      await page.getByTestId("discard-form-changes").click();

      await page.route("**/api/ssh", (route) =>
        route.fulfill({ json: { host: null, hosts: [longName], supported: true } }),
      );
      await page.route("**/api/terminals?**", (route) =>
        route.fulfill({
          json: { terminals: [], ready: true, reason: null, launchers: ["shell"], host: null },
        }),
      );
      await page.goto("/terminals");
      await page.getByTestId("terminal-new").click();
      const host = page.getByTestId("terminal-host-select");
      await nativeChevron(host);
      await host.focus();
      await host.press("End");
      await expect(host).toHaveValue(longName);
      await expect(host.locator("..").locator("svg")).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath(`terminal-dropdown-${theme}-${width}.png`),
        animations: "disabled",
      });

      const listboxes = await page.evaluate(() => {
        const container = document.createElement("div");
        container.style.cssText = "position:fixed;visibility:hidden;pointer-events:none";
        const multiple = document.createElement("select");
        multiple.multiple = true;
        const sized = document.createElement("select");
        sized.size = 4;
        const single = document.createElement("select");
        single.size = 1;
        container.append(multiple, sized, single);
        document.body.append(container);
        const images = [multiple, sized, single].map(
          (select) => getComputedStyle(select).backgroundImage,
        );
        container.remove();
        return images;
      });
      expect(listboxes[0]).toBe("none");
      expect(listboxes[1]).toBe("none");
      expect(listboxes[2]).toContain("data:image/svg+xml");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    });
  }
}
