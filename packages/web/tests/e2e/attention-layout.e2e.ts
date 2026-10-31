import { expect, test } from "@playwright/test";
import { attentionRequests } from "./_attention-fixtures";
import { attentionState } from "./_attention-state";
import { captureState } from "./_capture-state";
import { AUTH_HEADERS, gotoView, reviewAttentionRequest } from "./_helpers";

for (const [width, height, theme] of [
  [1440, 900, "dark"],
  [390, 844, "light"],
  [320, 568, "dark"],
] as const) {
  test(`attention choices and custom drafts stay usable at ${width}px ${theme}`, async ({
    page,
    request,
  }, info) => {
    await request.patch("/api/settings", { headers: AUTH_HEADERS, data: { theme } });
    const state = await attentionState(page);
    await page.setViewportSize({ width, height });
    await gotoView(page, "attention");
    const card = (id: string) => page.getByTestId(`attention-request-${id}`);
    const choice = card("choice"),
      free = card("free"),
      multi = card("multi");
    await expect(page.getByTestId("view-title")).toHaveText("Attention needed");
    await expect(
      page.getByTestId("attention-chat-70000000-0000-4000-8000-000000000001"),
    ).toBeVisible();
    await expect(page.getByTestId("attention-session-observed-session")).toBeVisible();
    await expect(choice.getByTestId("attention-answer")).not.toBeVisible();
    await expect(multi.getByTestId("attention-answer")).not.toBeVisible();
    await expect(free.getByTestId("attention-answer")).not.toBeVisible();
    await reviewAttentionRequest(free);
    await expect(free.getByTestId("attention-answer")).toBeVisible();
    await expect(page.getByTestId("attention-answer").filter({ visible: true })).toHaveCount(1);
    await expect(choice.getByTestId("attention-send")).toBeDisabled();
    await expect(card("delivery")).toContainText(
      "The agent disconnected before the answer was delivered.",
    );
    await expect(card("unavailable")).toContainText("Agent unavailable");
    expect(state.calls).toEqual([]);
    await page.evaluate(() => document.fonts.ready);
    await captureState(page, {
      path: info.outputPath(`attention-${width}x${height}-${theme}.png`),
      animations: "disabled",
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    const option = choice.getByTestId("attention-choice-Run focused checks");
    await reviewAttentionRequest(choice);
    if (width < 640) expect((await option.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await option.getByRole("radio").check();
    await expect(option.getByRole("radio")).toBeChecked();
    expect(state.calls).toEqual([]);
    const toggle = choice.getByTestId("attention-edit-answer");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await choice
      .getByTestId("attention-answer")
      .fill("Keep this custom draft while I review another question.");
    await toggle.click();
    await expect(choice.getByTestId("attention-answer")).not.toBeVisible();
    await reviewAttentionRequest(free);
    await free
      .getByTestId("attention-answer")
      .fill("Use staging and reproduce with the read-only fixture.");
    await reviewAttentionRequest(choice);
    await toggle.click();
    await expect(choice.getByTestId("attention-answer")).toHaveValue(
      "Keep this custom draft while I review another question.",
    );
    expect(state.calls).toEqual([]);
    await option.getByRole("radio").check();
    await choice.getByTestId("attention-send").click();
    await expect(choice.getByTestId("attention-response")).toHaveText("Run focused checks");
    expect(state.calls[0]).toEqual({
      id: "choice",
      operation: "respond",
      body: { version: 3, response: { kind: "question", answer: "Run focused checks" } },
    });
    await reviewAttentionRequest(free);
    await free.getByTestId("attention-send").click();
    await expect(free.getByTestId("attention-response")).toHaveText(
      "Use staging and reproduce with the read-only fixture.",
    );
    expect(state.calls[1]).toEqual({
      id: "free",
      operation: "respond",
      body: {
        version: 3,
        response: {
          kind: "question",
          answer: "Use staging and reproduce with the read-only fixture.",
        },
      },
    });
    await reviewAttentionRequest(multi);
    await multi.getByTestId("attention-choice-TypeScript").getByRole("checkbox").check();
    await multi.getByTestId("attention-choice-Browser workflows").getByRole("checkbox").check();
    await multi.getByTestId("attention-send").click();
    await expect(multi.getByTestId("attention-response")).toHaveText(
      "TypeScript, Browser workflows",
    );
    expect(state.calls[2]).toEqual({
      id: "multi",
      operation: "respond",
      body: {
        version: 3,
        response: {
          kind: "question",
          answer: "TypeScript, Browser workflows",
          selected_choices: ["TypeScript", "Browser workflows"],
        },
      },
    });
    const approval = card("approval");
    await reviewAttentionRequest(approval);
    await expect(approval.getByTestId("attention-action")).toContainText(
      "git status --short && git diff --stat",
    );
    await expect(approval).toContainText("/workspace/orc");
    await expect(approval).toContainText("build-host");
    const summary = approval.getByTestId("attention-native-details-toggle"),
      fullDetails = summary.locator("..");
    if (width < 640) {
      for (const name of ["attention-approve", "attention-deny", "attention-cancel"])
        expect((await approval.getByTestId(name).boundingBox())?.height).toBeGreaterThanOrEqual(44);
      expect((await summary.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    } else {
      const approve = await approval.getByTestId("attention-approve").boundingBox(),
        deny = await approval.getByTestId("attention-deny").boundingBox();
      expect(
        approve && deny && Math.abs(approve.y + approve.height / 2 - deny.y - deny.height / 2) < 2,
      ).toBe(true);
    }
    await expect(fullDetails).not.toHaveAttribute("open", "");
    await summary.click();
    await expect(fullDetails).toHaveAttribute("open", "");
    await expect(fullDetails).toContainText("fixture-thread");
    await summary.click();
    expect(state.calls).toHaveLength(3);
    await approval.scrollIntoViewIfNeeded();
    await captureState(page, {
      path: info.outputPath(`attention-approval-${width}-${theme}.png`),
      animations: "disabled",
    });
    expect(state.calls).toHaveLength(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

test("attention keeps the exact approval and failures visible while decisions and cancellation are pending", async ({
  page,
}, info) => {
  const initial = attentionRequests();
  const approval = initial.find((request) => request.id === "approval");
  if (!approval) throw new Error("Missing approval fixture");
  initial.push({
    ...approval,
    id: "accept",
    input: { ...approval.input, prompt: "Allow the agent to inspect package metadata?" },
  });
  const state = await attentionState(page, initial);
  await gotoView(page, "attention");
  const card = page.getByTestId("attention-request-approval");
  await reviewAttentionRequest(card);
  await expect(card.getByTestId("attention-action")).toContainText(
    "git status --short && git diff --stat",
  );
  await expect(card.getByText("/workspace/orc", { exact: true })).toBeVisible();
  await expect(card.getByText("build-host", { exact: true })).toBeVisible();
  state.failNext("approval", "respond", "Review service is temporarily unavailable.");
  const release = state.holdNext("approval", "respond");
  await card.getByTestId("attention-approve").click();
  await expect.poll(() => state.calls.length).toBe(1);
  for (const id of ["attention-approve", "attention-deny", "attention-cancel"])
    await expect(card.getByTestId(id)).toBeDisabled();
  release();
  await expect(card.getByTestId("attention-error")).toContainText(
    "Review service is temporarily unavailable.",
  );
  await expect(card.getByTestId("attention-action")).toBeVisible();
  expect(state.calls[0]).toEqual({
    id: "approval",
    operation: "respond",
    body: { version: 3, response: { kind: "approval", approved: true } },
  });
  await captureState(page, {
    path: info.outputPath("attention-approval-error.png"),
    animations: "disabled",
  });
  await card.getByTestId("attention-deny").click();
  await expect(card.getByTestId("attention-response")).toHaveText("Denied");
  expect(state.calls[1]).toEqual({
    id: "approval",
    operation: "respond",
    body: { version: 3, response: { kind: "approval", approved: false } },
  });
  await reviewAttentionRequest(page.getByTestId("attention-request-accept"));
  await page.getByTestId("attention-request-accept").getByTestId("attention-approve").click();
  await expect(
    page.getByTestId("attention-request-accept").getByTestId("attention-response"),
  ).toHaveText("Approved");
  expect(state.calls[2]).toEqual({
    id: "accept",
    operation: "respond",
    body: { version: 3, response: { kind: "approval", approved: true } },
  });
  const cancelled = page.getByTestId("attention-request-free");
  await reviewAttentionRequest(cancelled);
  state.failNext("free", "cancel", "The request could not be cancelled.");
  await cancelled.getByTestId("attention-cancel").click();
  await expect(cancelled.getByRole("alert")).toContainText("The request could not be cancelled.");
  await cancelled.getByTestId("attention-cancel").click();
  await expect(cancelled).toHaveCount(0);
  expect(state.calls.slice(3)).toEqual([
    { id: "free", operation: "cancel", body: { version: 3 } },
    { id: "free", operation: "cancel", body: { version: 3 } },
  ]);
});

test("attention custom reply disclosure works with the keyboard and preserves an unsent draft", async ({
  page,
}) => {
  const state = await attentionState(page);
  await gotoView(page, "attention");
  const card = page.getByTestId("attention-request-choice"),
    toggle = card.getByTestId("attention-edit-answer");
  await reviewAttentionRequest(card);
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await card.getByTestId("attention-answer").focus();
  await page.keyboard.type("Keyboard reply, still a draft");
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(card.getByTestId("attention-answer")).not.toBeVisible();
  await page.keyboard.press("Enter");
  await expect(card.getByTestId("attention-answer")).toHaveValue("Keyboard reply, still a draft");
  expect(state.calls).toEqual([]);
});

test("attention responds to its available pane width and keeps an unsent draft while chat opens", async ({
  page,
  request,
}, info) => {
  await request.patch("/api/settings", { headers: AUTH_HEADERS, data: { theme: "dark" } });
  const state = await attentionState(page);
  await page.route("**/api/chat/models?**", (route) =>
    route.fulfill({ json: { models: [], warning: null } }),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoView(page, "attention");
  const view = page.getByTestId("attention-view"),
    card = page.getByTestId("attention-request-choice");
  await reviewAttentionRequest(card);
  await card.getByTestId("attention-edit-answer").click();
  await card
    .getByTestId("attention-answer")
    .fill("Keep this draft while the workspace changes width.");
  const layout = () =>
    card.evaluate((element) => {
      const editor = element
        .querySelector('[data-testid="attention-answer"]')
        ?.getBoundingClientRect();
      const bounds = element.getBoundingClientRect();
      return {
        width: editor?.width ?? 0,
        contained: !!editor && editor.left >= bounds.left && editor.right <= bounds.right,
        overflow: element.scrollWidth > element.clientWidth,
      };
    });
  await expect.poll(async () => (await view.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(896);
  const wide = await layout();
  expect(wide.width).toBeGreaterThan(200);
  expect(wide.contained).toBe(true);
  await page.getByTestId("chat-open-button").click();
  await expect(page.getByTestId("chat-input")).toBeVisible();
  for (let step = 0; step < 16; step++)
    await page.getByTestId("chat-panel-resize").press("ArrowLeft");
  await expect.poll(async () => (await view.boundingBox())?.width ?? 0).toBeLessThan(896);
  const narrow = await layout();
  expect(narrow.width).toBeGreaterThan(0);
  expect(narrow.width).toBeLessThan(wide.width);
  expect(narrow.contained).toBe(true);
  expect(narrow.overflow).toBe(false);
  await expect(card.getByTestId("attention-answer")).toHaveValue(
    "Keep this draft while the workspace changes width.",
  );
  await captureState(page, {
    path: info.outputPath("attention-1440-narrow-pane.png"),
    animations: "disabled",
  });
  await page.getByTestId("chat-close-button").click();
  await expect.poll(async () => (await view.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(896);
  const restored = await layout();
  expect(Math.abs(restored.width - wide.width)).toBeLessThan(2);
  expect(restored.contained).toBe(true);
  await expect(card.getByTestId("attention-answer")).toHaveValue(
    "Keep this draft while the workspace changes width.",
  );
  expect(state.calls).toEqual([]);
});
