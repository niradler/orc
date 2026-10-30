import { expect, type Locator, type Page } from "@playwright/test";

/** Existing behavior tests use the field's real tab; focused step tests cover Next/Back. */
export async function revealFormField(page: Page, field: Locator | string) {
  const locator = typeof field === "string" ? page.getByTestId(field) : field;
  await locator.waitFor({ state: "attached" });
  const step = await locator.evaluate((element) =>
    element.closest("[data-form-step]")?.getAttribute("data-form-step"),
  );
  if (step) {
    const tab = page.getByTestId(`form-step-${step}`);
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
  }
}

export async function openFinalFormStep(page: Page) {
  const tab = page
    .getByRole("tablist", { name: "Form steps", exact: true })
    .getByRole("tab")
    .last();
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}
