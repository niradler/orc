import { expect, test } from "@playwright/test";
import { apiPost, gotoView, tid } from "./_helpers";

for (const width of [390, 1440]) {
  test(`chat link confirmation responds at ${width}px`, async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await context.route("https://example.com/chat-link", (route) =>
      route.fulfill({ contentType: "text/html", body: "<title>Confirmed chat link</title>" }),
    );
    await page.setViewportSize({ width, height: 900 });
    await gotoView(page, "overview");
    const open = page.getByTestId("chat-open-button");
    await expect(open).toBeVisible();
    await open.click();
    const input = page.getByTestId("chat-input").filter({ visible: true });
    await input.fill("[Example](https://example.com/chat-link)");
    await input.press("Enter");
    const link = page
      .locator('[data-testid="chat-message"][data-role="assistant"] [data-streamdown="link"]')
      .last();
    await expect(link).toBeVisible();
    await link.click();
    const modal = page.locator('[data-streamdown="link-safety-modal"]');
    await expect(modal).toBeVisible();
    await modal.getByRole("button", { name: "Copy link", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("https://example.com/chat-link");
    await modal.getByRole("button", { name: "Close", exact: true }).click();
    await expect(modal).toHaveCount(0);
    await link.click();
    await expect(modal).toBeVisible();
    await expect(modal.getByRole("button", { name: "Copy link", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    await expect(input).toBeVisible();
    for (let attempt = 0; attempt < 5; attempt++) {
      await link.click();
      await expect(modal.getByRole("button", { name: "Copy link", exact: true })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(modal).toHaveCount(0);
      await expect(input).toBeVisible();
    }
    await link.click();
    const popup = page.waitForEvent("popup");
    await modal.getByRole("button", { name: "Open link", exact: true }).click();
    expect((await popup).url()).toBe("https://example.com/chat-link");
    await expect(modal).toHaveCount(0);
    await expect(input).toBeEnabled();
  });
}

test("link confirmation responds inside a modal document sheet", async ({ page, request }) => {
  const name = tid("md-links");
  await apiPost(request, "/skills", {
    name,
    content: `---\nname: ${name}\ndescription: Link confirmation regression\n---\n\n[Example](https://example.com/document-link)`,
  });
  await gotoView(page, "skills");
  await page
    .locator(`[data-testid="skill-row"][data-skill-name="${name}"]`)
    .getByTestId("skill-open")
    .click();
  const preview = page.getByTestId("markdown-preview");
  await preview.locator('[data-streamdown="link"]').click();
  const modal = page.locator('[data-streamdown="link-safety-modal"]');
  await expect(modal).toBeVisible();
  await modal.getByRole("button", { name: "Close", exact: true }).click();
  await expect(modal).toHaveCount(0);
  await expect(preview).toBeVisible();
});
