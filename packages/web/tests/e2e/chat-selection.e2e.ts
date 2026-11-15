import { expect, type Page, test } from "@playwright/test";
import { API_SECRET } from "./_helpers";

async function openChatWithReply(page: Page): Promise<{
  assistant: ReturnType<Page["locator"]>;
  reply: ReturnType<Page["locator"]>;
  title: string;
}> {
  const prompt = "Respond after 100ms. Reply with exactly: SELECTION-SOURCE.";
  await page.goto("/tasks");
  await page.getByTestId("chat-open-button").click();
  await page.getByTestId("chat-input").fill(prompt);
  await page.getByTestId("chat-send-button").click();
  const assistant = page.locator('[data-testid="chat-message"][data-role="assistant"]').last();
  const content = assistant.getByTestId("chat-message-content");
  await expect(content).toContainText("SELECTION-SOURCE", { timeout: 15_000 });
  // The first message titles a new chat, so the source line can be asserted exactly.
  const title = (await page.locator(".chat-header h2").first().innerText()).trim();
  const reply = content.getByText("SELECTION-SOURCE", { exact: true }).first();
  return { assistant, reply, title };
}

async function selectReply(reply: ReturnType<Page["locator"]>): Promise<void> {
  // A triple click is a mouse selection of the paragraph, the same gesture a
  // reader uses to quote a line.
  await reply.click({ clickCount: 3 });
}

test.beforeEach(async ({ page, request }) => {
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
  await request.patch("/api/settings", {
    headers: { Authorization: `Bearer ${API_SECRET}` },
    data: { chat: { agent: "codex", permissionMode: "default" } },
  });
});

test("selects a reply, asks about it, dismisses with Escape and respects other zones", async ({
  page,
}) => {
  const { reply, title } = await openChatWithReply(page);
  const toolbar = page.getByTestId("chat-selection-toolbar");

  await selectReply(reply);
  await expect(toolbar).toBeVisible();
  await expect(toolbar).toHaveAttribute("aria-label", "Selection actions");

  await page.getByTestId("chat-selection-ask").click();
  await expect(toolbar).toBeHidden();
  const draft = page.getByTestId("chat-input");
  const asked = await draft.inputValue();
  expect(asked).toContain("> SELECTION-SOURCE");
  expect(asked).toContain(`Source: ${title} · Codex · `);
  // The quote is separated from anything typed before it by a blank line.
  await draft.fill("Keep this");
  await selectReply(reply);
  await page.getByTestId("chat-selection-ask").click();
  expect(await draft.inputValue()).toMatch(/^Keep this\n\n> SELECTION-SOURCE/);

  await selectReply(reply);
  await expect(toolbar).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(toolbar).toBeHidden();

  // A selection inside the terminal's own text layer is never taken over.
  await page.evaluate(() => {
    const host = document.querySelector(
      '[data-testid="chat-message"][data-role="assistant"] [data-testid="chat-message-content"]',
    );
    if (!host) throw new Error("assistant content missing");
    const layer = document.createElement("div");
    layer.dataset.testid = "terminal-text-layer";
    layer.textContent = "terminal-owned-selection";
    host.append(layer);
    const range = document.createRange();
    range.selectNodeContents(layer);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect(toolbar).toBeHidden();

  // A collapsed selection shows nothing.
  await page.evaluate(() => {
    window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect(toolbar).toBeHidden();
});

test("creates a prefilled task linked to the session", async ({ page }) => {
  const { reply, title } = await openChatWithReply(page);
  await selectReply(reply);
  await page.getByTestId("chat-selection-task").click();

  await expect(page.getByTestId("task-title-input")).toHaveValue("SELECTION-SOURCE");
  const body = await page.getByTestId("task-body-input").inputValue();
  expect(body).toContain("> SELECTION-SOURCE");
  expect(body).toContain(`Session: [${title}](/tasks?chat=full&chatThread=`);
  expect(body).toContain("· Codex · ");

  // The prefill is the dialog's baseline, so Escape closes without a dirty prompt.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("task-title-input")).toBeHidden();
});

test("copies the selection as Markdown with its source", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const { reply, title } = await openChatWithReply(page);
  await page.evaluate(() => navigator.clipboard.writeText(""));
  await selectReply(reply);
  await page.getByTestId("chat-selection-copy-md").click();

  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain("> SELECTION-SOURCE");
  const copied = (await page.evaluate(() => navigator.clipboard.readText())).replaceAll(
    "\r\n",
    "\n",
  );
  expect(copied.startsWith("> SELECTION-SOURCE\n\nSource: ")).toBe(true);
  expect(copied).toContain(`Source: ${title} · Codex · `);
  // The source line carries a locale time after the agent label.
  expect((copied.split("Source: ")[1] ?? "").split(" · ").length).toBe(3);
  await selectReply(reply);
  await page.getByTestId("chat-selection-copy").click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toMatch(/^SELECTION-SOURCE\s*$/);
  // Escape still dismisses after copying, whether or not the toolbar stayed up.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("chat-selection-toolbar")).toBeHidden();
});

test("offers the same actions in the message menu for keyboard use", async ({ page }) => {
  const { assistant, title } = await openChatWithReply(page);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.getByTestId("chat-input").fill("");

  const trigger = assistant.getByTestId("chat-message-selection-menu");
  await trigger.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByTestId("chat-message-selection-actions");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveCount(4);
  await page.keyboard.press("Enter");

  const draft = page.getByTestId("chat-input");
  await expect(draft).toHaveValue(/^> SELECTION-SOURCE/);
  expect(await draft.inputValue()).toContain(`\n\nSource: ${title} · Codex · `);
});

test("saves the selection to a linked scratchpad", async ({ page, request }) => {
  const { reply } = await openChatWithReply(page);
  await selectReply(reply);
  await page.getByTestId("chat-selection-save").click();

  await expect(page.getByTestId("scratchpad-form")).toBeVisible();
  await expect(page.getByTestId("scratchpad-form-title")).toHaveValue("SELECTION-SOURCE");
  await page.getByTestId("scratchpad-form-submit").click();

  const saved = page.getByTestId("chat-selection-saved");
  await expect(saved).toBeVisible();
  const link = page.getByTestId("chat-selection-saved-link");
  await expect(link).toHaveText("SELECTION-SOURCE");
  const href = await link.getAttribute("href");
  expect(href).toMatch(/^\/scratchpad\/.+/);

  // The pad was created with the quote and source line, not an empty shell.
  const id = href?.split("/").pop() ?? "";
  await expect
    .poll(async () => {
      const response = await request.get(`/api/scratchpads/${id}`, {
        headers: { Authorization: `Bearer ${API_SECRET}` },
      });
      if (!response.ok()) return null;
      return (await response.json()).content as string;
    })
    .toContain("> SELECTION-SOURCE");
});

test("keeps the toolbar and the menu path inside a phone viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { assistant, reply } = await openChatWithReply(page);
  await selectReply(reply);
  const toolbar = page.getByTestId("chat-selection-toolbar");
  await expect(toolbar).toBeVisible();
  const box = await toolbar.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(391);
  expect(
    (await page.evaluate(() => document.documentElement.scrollWidth)) - 390,
  ).toBeLessThanOrEqual(1);

  await page.keyboard.press("Escape");
  await expect(toolbar).toBeHidden();
  const trigger = assistant.getByTestId("chat-message-selection-menu");
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(page.getByTestId("chat-message-selection-actions")).toBeVisible();
  await expect(page.getByTestId("chat-message-selection-copy")).toBeVisible();
});

test.describe("touch", () => {
  test.use({ hasTouch: true });

  test("a touch selection opens a toolbar with 44px actions that tap into the composer", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { reply } = await openChatWithReply(page);
    // A phone selects by long-press; the selection event is what the toolbar reads.
    await reply.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    const toolbar = page.getByTestId("chat-selection-toolbar");
    await expect(toolbar).toBeVisible();

    // Every action is a full touch target, not a hover-sized control.
    for (const id of [
      "chat-selection-ask",
      "chat-selection-task",
      "chat-selection-save",
      "chat-selection-copy",
      "chat-selection-copy-md",
    ]) {
      const box = await toolbar.getByTestId(id).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    const ask = await toolbar.getByTestId("chat-selection-ask").boundingBox();
    expect(ask).not.toBeNull();
    await page.touchscreen.tap(
      (ask?.x ?? 0) + (ask?.width ?? 0) / 2,
      (ask?.y ?? 0) + (ask?.height ?? 0) / 2,
    );
    await expect(toolbar).toBeHidden();
    await expect(page.getByTestId("chat-input")).toHaveValue(/^> SELECTION-SOURCE/);
  });

  test("the session actions, queue disclosure and send stay touch-sized on a phone", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openChatWithReply(page);
    const panel = page.getByTestId("chat-panel").filter({ visible: true });
    for (const id of ["chat-options-button", "chat-send-button", "chat-attach-button"]) {
      const box = await panel.getByTestId(id).boundingBox();
      // Touch emulation scales the layout viewport, so a 44px target measures
      // 43.98; round before comparing against the minimum.
      expect(Math.round(box?.height ?? 0)).toBeGreaterThanOrEqual(44);
    }
  });
});
