import { expect, test } from "@playwright/test";
import { apiPost, gotoView, tid } from "./_helpers";

test("agent and package panels resize, remember their width, and fit a phone", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const id = tid("readable-agent");
  await apiPost(request, "/agents", {
    id,
    content:
      "---\nname: Lab researcher\ndescription: Investigate a service and return evidence with practical next steps.\nmodel: configured-model\n---\n# Lab researcher\n\n## Research process\n\nRead the project context and inspect the running service before proposing a change.\n\n## Report\n\nExplain what you found, cite the evidence, and identify the next useful action.",
  });
  await gotoView(page, "packages");
  await page.goto("/packages/agents?project=all");
  await page.locator(`[data-testid="agent-row"][data-agent-id="${id}"]`).click();
  const panel = page.getByTestId("agent-detail-sheet");
  await expect(page.getByTestId("markdown-preview")).toContainText("Research process");
  const before = await panel.boundingBox();
  expect(before?.width).toBeGreaterThanOrEqual(850);
  const handle = page.getByTestId("sheet-resize-handle");
  await handle.hover();
  const bounds = await handle.boundingBox();
  if (!bounds) throw Error("Missing splitter");
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 180);
  await page.mouse.down();
  await page.mouse.move(bounds.x - 300, bounds.y + 180, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => (await panel.boundingBox())?.width)
    .toBeGreaterThan((before?.width ?? 0) + 250);
  const expanded = await panel.boundingBox();
  await page.screenshot({ path: "../../output/playwright/agent-detail-desktop.png" });
  await page.getByTestId("sheet-close").click();
  await page.locator(`[data-testid="agent-row"][data-agent-id="${id}"]`).click();
  expect((await panel.boundingBox())?.width).toBe(expanded?.width);
  await handle.focus();
  await handle.press("ArrowLeft");
  await expect
    .poll(async () => (await panel.boundingBox())?.width)
    .toBeGreaterThan(expanded?.width ?? 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await panel.boundingBox())?.width).toBeLessThanOrEqual(390);
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await expect(handle).toBeHidden();
  await page.screenshot({ path: "../../output/playwright/agent-detail-mobile.png" });
  await page.getByTestId("sheet-close").click();

  const name = tid("readable-package");
  await apiPost(request, "/agent-packages", {
    name,
    content: `name: ${name}\nversion: 1.0.0\ndescription: Reusable research instructions\n`,
    files: [],
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await gotoView(page, "packages");
  await page
    .locator(`[data-testid="agent-package-row"][data-package-name="${name}"]`)
    .getByTestId("package-inspect")
    .click();
  await expect(page.getByTestId("sheet-resize-handle")).toBeVisible();
  expect(
    (await page.getByTestId("package-detail-sheet").boundingBox())?.width,
  ).toBeGreaterThanOrEqual(950);
  await expect(page.getByTestId("package-actions")).toBeVisible();
  await expect(page.getByTestId("package-file-content")).toContainText(name);
  await page.screenshot({ path: "../../output/playwright/package-detail-desktop.png" });
});

test("Rules aligns Add rule to the workspace edge and hides enforcement for an empty view", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.route("**/api/rules", (route) =>
    route.fulfill({ json: { enabled: false, history: [], decisions: [], actions: [] } }),
  );
  await gotoView(page, "rules");
  await expect(page.getByTestId("rules-status")).toHaveCount(0);
  const workspace = await page.getByTestId("rules-view").boundingBox();
  const add = await page.getByTestId("rule-new").boundingBox();
  if (!workspace || !add) throw Error("Missing Rules toolbar");
  expect(Math.abs(workspace.x + workspace.width - add.x - add.width)).toBeLessThan(5);
  await page.screenshot({ path: "../../output/playwright/rules-desktop.png" });
  await page.getByTestId("rule-new").click();
  await expect(page.getByTestId("sheet-resize-handle")).toBeVisible();
});
