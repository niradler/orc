import { expect, test } from "@playwright/test";
import { apiGet, apiPost, gotoView, tid } from "./_helpers";

test("icon action help appears on hover and keyboard focus without replacing its action", async ({
  page,
  request,
}) => {
  const name = tid("explained-action");
  const job = await apiPost<{ id: string }>(request, "/jobs", {
    name,
    command: "echo fixture",
    trigger_type: "manual",
    enabled: false,
  });
  await gotoView(page, "jobs");
  const icon = page
    .locator(`[data-testid="job-row"][data-job-id="${job.id}"]`)
    .getByTestId("job-delete");
  await icon.hover();
  await expect(page.getByTestId("action-help-content")).toHaveText(`Delete ${name}`);
  await expect(page.getByTestId("confirm-dialog-confirm")).toHaveCount(0);
  await page.mouse.move(0, 0);
  await icon.focus();
  await expect(page.getByTestId("action-help-content")).toBeVisible();
  await expect(icon).toBeFocused();
  await icon.press("Enter");
  await expect(page.getByTestId("confirm-dialog-confirm")).toBeVisible();
  await page.keyboard.press("Escape");
  expect((await apiGet<{ id: string }>(request, `/jobs/${job.id}`)).id).toBe(job.id);
});

test.describe("touch action help", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("holding inline repository Search explains it without discovering and a tap discovers once", async ({
    page,
  }) => {
    let discoveries = 0;
    await page.route("**/api/skills/discover", (route) => {
      discoveries++;
      return route.fulfill({
        json: {
          repository: "acme/skills",
          ref: "HEAD",
          path: "",
          commit: "a".repeat(40),
          skills: [],
          issues: [],
        },
      });
    });
    await gotoView(page, "skills");
    await page.getByTestId("skill-import-menu").click();
    await page.getByTestId("import-skill-button").click();
    await page.getByTestId("skill-repository-input").fill("acme/skills");
    const search = page.getByTestId("skill-discover");
    const box = await search.boundingBox();
    if (!box) throw new Error("Missing repository Search");
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const touch = await page.context().newCDPSession(page);
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ ...point, id: 1 }],
    });
    await expect(page.getByTestId("action-help-content")).toHaveText(
      "Find skills in this repository",
    );
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    expect(discoveries).toBe(0);
    await page.touchscreen.tap(point.x, point.y);
    await expect(page.getByTestId("skill-import-body").getByRole("status")).toContainText(
      "No valid skills found",
    );
    expect(discoveries).toBe(1);
    await touch.detach();
  });

  test("a touch hold explains the icon without executing it and a short tap keeps the normal action", async ({
    page,
    request,
  }, testInfo) => {
    const name = tid("touch-explained-action");
    const job = await apiPost<{ id: string }>(request, "/jobs", {
      name,
      command: "echo fixture",
      trigger_type: "manual",
      enabled: false,
    });
    let deletes = 0;
    page.on("request", (event) => {
      if (event.method() === "DELETE") deletes++;
    });
    await gotoView(page, "jobs");
    const icon = page
      .locator(`[data-testid="job-row"][data-job-id="${job.id}"]`)
      .getByTestId("job-delete");
    await icon.scrollIntoViewIfNeeded();
    const bounds = await icon.boundingBox();
    if (!bounds) throw new Error("Missing icon action");
    const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const touch = await page.context().newCDPSession(page);
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ ...point, id: 1 }],
    });
    await expect(page.getByTestId("action-help-content")).toHaveText(`Delete ${name}`);
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(page.getByTestId("confirm-dialog-confirm")).toHaveCount(0);
    expect(deletes).toBe(0);
    await page.screenshot({
      path: testInfo.outputPath("touch-action-help.png"),
      animations: "disabled",
    });
    await page.touchscreen.tap(point.x, point.y);
    await expect(page.getByTestId("confirm-dialog-confirm")).toBeVisible();
    expect(deletes).toBe(0);
    await page.keyboard.press("Escape");
    expect((await apiGet<{ id: string }>(request, `/jobs/${job.id}`)).id).toBe(job.id);
    await touch.detach();
  });
});
