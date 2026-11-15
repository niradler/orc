import { ChatSettingsSchema } from "@orc/core/chat";
import { expect, type Page, test } from "@playwright/test";
import { holdChatStream } from "./_chat-stream";
import { openChatActions } from "./_chat-ui";
import { API_SECRET } from "./_helpers";

const headers = { Authorization: `Bearer ${API_SECRET}` };

test.beforeEach(async ({ page, request }) => {
  await request.patch("/api/settings", {
    headers,
    data: {
      chat: ChatSettingsSchema.parse({ agent: "codex", permissionMode: "default" }),
    },
  });
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
});

async function openBlankChat(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/tasks");
  await page.getByTestId("chat-open-button").click();
  const panel = page.getByTestId("chat-panel").filter({ visible: true });
  await expect(panel.getByTestId("chat-input")).toBeVisible();
  return panel;
}

test("focus chat hides the strip and queue while keeping the composer, Stop and errors", async ({
  page,
}) => {
  const panel = await openBlankChat(page, 1440);
  const release = await holdChatStream(page);
  try {
    await panel.getByTestId("chat-input").fill("Respond after 3000ms. Reply with exactly: FIRST.");
    await panel.getByTestId("chat-send-button").click();
    await expect(panel).toHaveAttribute("data-streaming", "true");
    await panel.getByTestId("chat-input").fill("Reply with exactly: SECOND.");
    await panel.getByTestId("chat-send-button").click();
    await expect(panel.getByTestId("chat-message-queue")).toHaveCount(1);

    await expect(panel.getByTestId("chat-focus-toggle")).toHaveAttribute("aria-pressed", "false");
    await panel.getByTestId("chat-focus-toggle").click();
    await expect(panel).toHaveAttribute("data-focus", "true");
    await expect(panel.getByTestId("chat-focus-toggle")).toHaveAttribute("aria-pressed", "true");
    // Focus hides the chrome a reader does not need mid-conversation.
    await expect(panel.getByTestId("chat-session-strip")).toHaveCount(0);
    await expect(panel.getByTestId("chat-message-queue")).toHaveCount(0);
    // But never the working controls or the transcript.
    await expect(panel.getByTestId("chat-composer-box")).toBeVisible();
    await expect(panel.getByTestId("chat-input")).toBeVisible();
    await expect(panel.getByTestId("chat-cancel-button")).toBeVisible();
    await expect(panel.getByTestId("chat-messages")).toBeVisible();
  } finally {
    await release();
  }
  await expect(panel).toHaveAttribute("data-streaming", "false");
  await expect(panel.getByTestId("chat-message-content").last()).toContainText("SECOND");

  // Escape leaves focus, and the strip comes back.
  await page.keyboard.press("Escape");
  await expect(panel).toHaveAttribute("data-focus", "false");
  await expect(panel.getByTestId("chat-session-strip")).toHaveCount(1);

  // The session actions menu reaches the same toggle, and keeps Escape for itself.
  await openChatActions(page);
  await expect(page.getByTestId("chat-focus-menu")).toHaveAttribute("aria-pressed", "false");
  await page.getByTestId("chat-focus-menu").click();
  await expect(panel).toHaveAttribute("data-focus", "true");
  await expect(panel.getByTestId("chat-session-strip")).toHaveCount(0);
  await openChatActions(page);
  await expect(page.getByTestId("chat-actions-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("chat-actions-menu")).toBeHidden();
  await expect(panel).toHaveAttribute("data-focus", "true");

  // An error stays visible and Send stays usable in focus.
  await page.route("**/api/chat/stream", async (route) => {
    if (route.request().postDataJSON()?.messages?.[0]?.content === "FAIL PLEASE") {
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "Selected agent is unavailable." }),
      });
      return;
    }
    await route.continue();
  });
  await panel.getByTestId("chat-input").fill("FAIL PLEASE");
  await panel.getByTestId("chat-send-button").click();
  await expect(panel.getByTestId("chat-error")).toContainText("Selected agent is unavailable");
  await expect(panel.getByTestId("chat-composer-box")).toBeVisible();
  await expect(panel).toHaveAttribute("data-focus", "true");

  await page.keyboard.press("Escape");
  await expect(panel).toHaveAttribute("data-focus", "false");
});

test("focus chat keeps the phone composer reachable without overflow", async ({ page }) => {
  const panel = await openBlankChat(page, 390);
  await panel.getByTestId("chat-focus-toggle").click();
  await expect(panel).toHaveAttribute("data-focus", "true");
  await expect(panel.getByTestId("chat-session-strip")).toHaveCount(0);
  await expect(panel.getByTestId("chat-composer-box")).toBeVisible();

  const input = await panel.getByTestId("chat-input").boundingBox();
  expect(input?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect((input?.y ?? 0) + (input?.height ?? 0)).toBeLessThanOrEqual(900);
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);
  // Every phone control keeps its 44px target.
  for (const id of ["chat-focus-toggle", "chat-send-button", "chat-attach-button"]) {
    const box = await panel.getByTestId(id).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }

  const release = await holdChatStream(page);
  try {
    await panel.getByTestId("chat-input").fill("Respond after 3000ms. Reply with exactly: PHONE.");
    await panel.getByTestId("chat-send-button").click();
    await expect(panel.getByTestId("chat-cancel-button")).toBeVisible();
  } finally {
    await release();
  }
  await page.keyboard.press("Escape");
  await expect(panel).toHaveAttribute("data-focus", "false");

  // Focus belongs to this chat: starting another chat leaves focus.
  await panel.getByTestId("chat-focus-toggle").click();
  await expect(panel).toHaveAttribute("data-focus", "true");
  await panel.getByTestId("chat-clear-button").click();
  await expect(panel).toHaveAttribute("data-focus", "false");
});

for (const width of [1440, 390]) {
  test(`blank chat centres the hero composer and the first send docks it at ${width}px`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __handoffs: number };
      w.__handoffs = 0;
      const original = Element.prototype.animate;
      Element.prototype.animate = function (keyframes, options) {
        if (typeof options === "object" && options?.duration === 180) w.__handoffs += 1;
        return original.call(this, keyframes, options);
      };
    });
    const panel = await openBlankChat(page, width);
    const footer = panel.locator(".chat-composer-footer");
    const input = panel.getByTestId("chat-input");
    await expect(footer).toHaveAttribute("data-hero", "true");
    await expect(panel.locator(".chat-empty-state")).toContainText("What are you working on?");

    // The textarea gets room for three rows, under the heading, around the middle.
    expect((await input.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(80);
    const heading = await panel.locator(".chat-empty-state h3").boundingBox();
    const composer = await panel.getByTestId("chat-composer-box").boundingBox();
    const panelBox = await panel.boundingBox();
    expect(heading).not.toBeNull();
    expect(composer).not.toBeNull();
    expect(panelBox).not.toBeNull();
    expect(heading?.y ?? 0).toBeLessThan(composer?.y ?? 0);
    expect((composer?.y ?? 0) - (panelBox?.y ?? 0)).toBeLessThan((panelBox?.height ?? 0) * 0.75);

    await input.fill("Reply with exactly: HERO.");
    if (width === 1440) await input.press("Enter");
    else await panel.getByTestId("chat-send-button").click();
    await expect(footer).toHaveAttribute("data-hero", "false");
    // Exactly the one hero→docked handoff ran; nothing else animated the composer.
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __handoffs: number }).__handoffs ?? 0),
      )
      .toBe(1);
    await expect(panel.getByTestId("chat-message-content").last()).toContainText("HERO");
    // Desktop sends with Enter, and the same textarea keeps the caret: the hero
    // docks instead of remounting. A phone taps Send, so focus is the button's.
    if (width === 1440) await expect(input).toBeFocused();
    // The FLIP settles back to no transform before geometry is read.
    await expect
      .poll(() =>
        panel.getByTestId("chat-composer-box").evaluate((el) => getComputedStyle(el).transform),
      )
      .toBe("none");
    const docked = await panel.getByTestId("chat-composer-box").boundingBox();
    expect(
      (panelBox?.y ?? 0) + (panelBox?.height ?? 0) - ((docked?.y ?? 0) + (docked?.height ?? 0)),
    ).toBeLessThan(24);
    await expect(panel.locator(".chat-empty-state")).toHaveCount(0);
    // A later message is already docked, so it never animates.
    if (width === 1440) {
      await input.fill("Reply with exactly: NEXT.");
      await input.press("Enter");
      await expect(panel.getByTestId("chat-message-content").last()).toContainText("NEXT");
      expect(
        await panel.getByTestId("chat-composer-box").evaluate((el) => el.getAnimations().length),
      ).toBe(0);
    }
  });
}

test("reduced motion skips the composer handoff and leaves no transform", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const w = window as unknown as { __handoffs: number };
    w.__handoffs = 0;
    const original = Element.prototype.animate;
    Element.prototype.animate = function (keyframes, options) {
      if (typeof options === "object" && options?.duration === 180) w.__handoffs += 1;
      return original.call(this, keyframes, options);
    };
  });
  const panel = await openBlankChat(page, 1440);
  const footer = panel.locator(".chat-composer-footer");
  await expect(footer).toHaveAttribute("data-hero", "true");
  await panel.getByTestId("chat-input").fill("Reply with exactly: CALM.");
  await panel.getByTestId("chat-input").press("Enter");
  await expect(footer).toHaveAttribute("data-hero", "false");
  await expect(panel.getByTestId("chat-message-content").last()).toContainText("CALM");
  const composer = panel.getByTestId("chat-composer-box");
  expect(await composer.evaluate((element) => element.getAnimations().length)).toBe(0);
  expect(await composer.evaluate((element) => getComputedStyle(element).transform)).toBe("none");
  // The animation was never requested, so this cannot pass by deleting the call site.
  expect(await page.evaluate(() => (window as unknown as { __handoffs: number }).__handoffs)).toBe(
    0,
  );
});

test("a streaming fenced answer renders one code block while the text arrives", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    const encoder = new TextEncoder();
    const chunks = [
      'data: {"type":"text","text":"Intro line.\\n\\n"}\n\n',
      'data: {"type":"text","text":"```ts\\nconst answer = 42;\\n"}\n\n',
      'data: {"type":"text","text":"console.log(answer);\\n```\\n\\n"}\n\n',
      'data: {"type":"text","text":"Closing line."}\n\ndata: {"type":"done"}\n\n',
    ];
    let intercept = true;
    window.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!intercept || !new URL(url, location.href).pathname.endsWith("/chat/stream"))
        return original(input, init);
      intercept = false;
      let index = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          Object.assign(window, {
            nextChatChunk: () => {
              const chunk = chunks[index++];
              if (chunk === undefined) controller.close();
              else controller.enqueue(encoder.encode(chunk));
            },
          });
          // The first chunk is already buffered; the test releases the rest.
          (window as unknown as { nextChatChunk: () => void }).nextChatChunk();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
  });
  const panel = await openBlankChat(page, 1440);
  await panel.getByTestId("chat-input").fill("Write a code sample");
  await panel.getByTestId("chat-send-button").click();
  const assistant = panel.locator('[data-testid="chat-message"][data-role="assistant"]').last();
  await expect(assistant).toContainText("Intro line.");

  const push = () =>
    page.evaluate(() => (window as unknown as { nextChatChunk: () => void }).nextChatChunk());
  // The fence is still open: the code is visible and is one code block.
  await push();
  await expect(assistant).toContainText("const answer = 42;");
  await expect(assistant.locator('[data-streamdown="code-block"]')).toHaveCount(1);
  await push();
  await expect(assistant).toContainText("console.log(answer);");
  await expect(assistant.locator('[data-streamdown="code-block"]')).toHaveCount(1);
  await push();
  await expect(assistant).toContainText("Closing line.");
  await expect(panel).toHaveAttribute("data-streaming", "false");
  // The finished answer is still exactly one fenced code block.
  await expect(assistant.locator('[data-streamdown="code-block"]')).toHaveCount(1);
  await expect(assistant.locator("pre")).toHaveCount(1);
});
