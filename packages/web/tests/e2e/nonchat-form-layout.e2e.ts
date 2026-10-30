import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, test } from "@playwright/test";
import { openFinalFormStep, revealFormField } from "./_form-ui";
import { apiPost, gotoView, repoRoot, tid } from "./_helpers";

async function expectStableFooter(dialog: Locator, width: number, height: number) {
  const bounds = await dialog.evaluate((element) => {
    const form = element.getBoundingClientRect();
    const footer = element.querySelector(".work-form-footer")?.getBoundingClientRect();
    return { width: form.width, top: footer?.top, bottom: footer?.bottom };
  });
  expect(bounds.width).toBeGreaterThan(width < 640 ? width - 1 : 900);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(height + 1);
}

for (const width of [1440, 390, 320]) {
  test(`scratchpad form keeps draft and actions reachable at ${width}px`, async ({
    page,
    request,
  }) => {
    const project = await apiPost<{ id: string }>(request, "/projects", {
      name: tid("pad-layout"),
    });
    const height = width < 640 ? 650 : 900;
    await page.setViewportSize({ width, height });
    await gotoView(page, "scratchpads");
    await page.goto(`/scratchpad?project=${project.id}&padProject=${project.id}`);
    await page.getByTestId("new-scratchpad-button").click();
    const dialog = page.getByTestId("scratchpad-form");
    await expect(dialog).toBeVisible();
    await expectStableFooter(dialog, width, height);
    for (const kind of ["doc", "diagram", "html"]) {
      const choice = dialog.getByTestId(`scratchpad-form-kind-${kind}`);
      await choice.click();
      await expect(choice).toHaveAttribute("aria-pressed", "true");
      if (width < 640) {
        const box = await choice.boundingBox();
        expect(box?.height).toBeGreaterThanOrEqual(44);
      }
    }
    await expect(dialog.getByTestId("scratchpad-kind-hint")).toContainText("sandboxed");
    const title = tid("draft-pad");
    await dialog.getByTestId("scratchpad-form-title").fill(title);
    await page.keyboard.press("Escape");
    await page.getByTestId("keep-editing").click();
    await expect(dialog.getByTestId("scratchpad-form-title")).toHaveValue(title);
    await expect(dialog.getByTestId("scratchpad-form-kind-html")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await dialog.getByTestId("scratchpad-form-kind-doc").click();
    await expect(dialog.getByTestId("scratchpad-form-kind-doc")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const output = join(repoRoot(), ".claude/validation/nonchat-form-layout");
    mkdirSync(output, { recursive: true });
    await page.screenshot({
      path: join(output, `scratchpad-${width}.png`),
      animations: "disabled",
    });
    await dialog.getByTestId("scratchpad-form-submit").click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("scratchpad-page")).toBeVisible();
    await expect(page.getByTestId("scratchpad-title")).toHaveText(title);
    await expect(page.getByTestId("discard-form-changes")).toHaveCount(0);
    await page.getByTestId("scratchpad-properties").click();
    await dialog.getByTestId("scratchpad-form-tags").fill("temporary,");
    await dialog.getByRole("button", { name: "Remove temporary", exact: true }).click();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("discard-form-changes")).toHaveCount(0);
    await page.getByTestId("scratchpad-properties").click();
    await dialog.getByTestId("scratchpad-form-tags").fill("draft-tag");
    await page.keyboard.press("Escape");
    await page.getByTestId("keep-editing").click();
    await expect(dialog.getByTestId("tag-input-tag")).toContainText("draft-tag");
    await dialog.getByTestId("scratchpad-form-title").fill(`${title} updated`);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByTestId("discard-form-changes").click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("scratchpad-title")).toHaveText(title);
  });

  test(`memory form keeps draft and committed save navigation at ${width}px`, async ({
    page,
    request,
  }) => {
    const project = await apiPost<{ id: string }>(request, "/projects", {
      name: tid("memory-layout"),
    });
    const height = width < 640 ? 650 : 900;
    await page.setViewportSize({ width, height });
    await gotoView(page, "memories");
    await page.goto(`/knowledge/memories?project=${project.id}`);
    await page.getByTestId("new-memory-button").click();
    const dialog = page.getByTestId("memory-form-dialog");
    await expect(dialog).toBeVisible();
    await expectStableFooter(dialog, width, height);
    const name = tid("review-memory").toLowerCase();
    const saves: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/memories"))
        saves.push(request.url());
    });
    await openFinalFormStep(page);
    await dialog.getByTestId("memory-content-input").fill("Retained content draft");
    await dialog.getByTestId("memory-submit").click();
    await expect(dialog.getByTestId("form-step-details")).toHaveAttribute("aria-selected", "true");
    await expect(dialog.getByTestId("memory-name-input")).toBeFocused();
    expect(saves).toEqual([]);
    await dialog.getByTestId("memory-name-input").fill(name);
    await dialog.getByTestId("memory-description-input").fill("Non-chat form review");
    await dialog.getByTestId("memory-priority-input").fill("60");
    await dialog.getByTestId("form-step-next").click();
    await expect(dialog.getByTestId("memory-content-input")).toHaveValue("Retained content draft");
    await dialog
      .getByTestId("memory-content-input")
      .fill("Keep draft text while reviewing the form.");
    await dialog.getByTestId("form-step-back").click();
    await expect(dialog.getByTestId("memory-name-input")).toHaveValue(name);
    await expect(dialog.getByTestId("memory-description-input")).toHaveValue(
      "Non-chat form review",
    );
    await expect(dialog.getByTestId("memory-priority-input")).toHaveValue("60");
    await openFinalFormStep(page);
    await expectStableFooter(dialog, width, height);
    await page.keyboard.press("Escape");
    await page.getByTestId("keep-editing").click();
    await expect(dialog.getByTestId("memory-content-input")).toHaveValue(
      "Keep draft text while reviewing the form.",
    );
    const output = join(repoRoot(), ".claude/validation/nonchat-form-layout");
    mkdirSync(output, { recursive: true });
    await page.screenshot({ path: join(output, `memory-${width}.png`), animations: "disabled" });
    await dialog.getByTestId("memory-submit").click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/knowledge/memories/${project.id}/${name}`));
    await expect(page.getByTestId("memory-detail-content")).toHaveText(
      "Keep draft text while reviewing the form.",
    );
    await expect(page.getByTestId("discard-form-changes")).toHaveCount(0);
    await page.getByTestId("memory-edit").click();
    await revealFormField(page, "memory-description-input");
    await dialog.getByTestId("memory-description-input").fill("Changed description");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByTestId("discard-form-changes").click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("memory-detail-description")).toHaveText("Non-chat form review");
  });
}
