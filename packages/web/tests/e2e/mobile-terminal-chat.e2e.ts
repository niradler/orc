import { devices, expect, type Page } from "@playwright/test";
import { apiGet, apiPost, gotoView } from "./_helpers";
import { test } from "./_terminal-fixture";

test.use({ ...devices["Pixel 7"], viewport: { width: 390, height: 844 } });

async function touch(page: Page, points: { x: number; y: number }[][]) {
  if (page.context().browser()?.browserType().name() !== "chromium") {
    await page.evaluate((points) => {
      const first = points[0]?.[0];
      if (!first) throw new Error("Missing first touch");
      const target = document.elementFromPoint(first.x, first.y);
      if (!target) throw new Error("Missing touch target");
      for (const [index, touches] of points.entries())
        target.dispatchEvent(
          Object.assign(
            new Event(index === 0 ? "touchstart" : touches.length ? "touchmove" : "touchend", {
              bubbles: true,
              cancelable: true,
            }),
            {
              touches: touches.map((point, identifier) => ({
                identifier,
                clientX: point.x,
                clientY: point.y,
              })),
            },
          ),
        );
    }, points);
    return;
  }
  const session = await page.context().newCDPSession(page);
  try {
    for (const [index, touches] of points.entries()) {
      await session.send("Input.dispatchTouchEvent", {
        type: index === 0 ? "touchStart" : touches.length ? "touchMove" : "touchEnd",
        touchPoints: touches.map((point, id) => ({ ...point, id })),
      });
    }
  } finally {
    await session.detach();
  }
}

test("Android terminal keyboard, real swipe scrolling and pinch zoom keep the process running", async ({
  page,
  request,
}, testInfo) => {
  const terminal = await apiPost<{ id: string; pid: number }>(request, "/terminals", {
    kind: "shell",
    host: null,
  });
  const sent: string[] = [];
  let output = "";
  page.on("websocket", (socket) => {
    if (!socket.url().includes(`/terminals/${terminal.id}/ws`)) return;
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") sent.push(payload.toString());
    });
    socket.on("framereceived", ({ payload }) => {
      output += payload.toString();
    });
  });
  await gotoView(page, "terminals");
  await page.goto(`/terminals/${terminal.id}?project=all`);
  const controls = page.getByTestId("terminal-touch-controls");
  const keyboard = controls.getByTestId("terminal-keyboard-show");
  await expect(keyboard).toBeEnabled();
  await keyboard.tap();
  const input = page.locator("textarea[aria-label='Terminal input']").first();
  await expect(input).toBeFocused();
  const command =
    process.platform === "win32"
      ? '1..150 | ForEach-Object { "TOUCH_LINE_$_" }'
      : "for i in $(seq 1 150); do echo TOUCH_LINE_$i; done";
  await input.evaluate((element, text) => {
    element.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: text,
      }),
    );
    element.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertLineBreak",
      }),
    );
  }, command);
  await expect.poll(() => output).toContain("TOUCH_LINE_150");
  await expect.poll(() => sent.join("")).toContain(command);
  const surface = page.getByTestId("terminal-surface");
  const box = await surface.boundingBox();
  if (!box) throw new Error("No terminal surface");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 3;
  await touch(page, [[{ x, y }], [{ x, y: y + 25 }], [{ x, y: y + 60 }], [{ x, y: y + 100 }], []]);
  await expect
    .poll(async () => Number(await surface.getAttribute("data-scroll-offset")))
    .toBeGreaterThan(0);
  await expect(input).toBeFocused();
  await expect(surface).toHaveAttribute("data-font-size", "13");
  const strip = controls.getByTestId("terminal-special-keys");
  const stripBox = await strip.boundingBox();
  if (!stripBox) throw new Error("Missing shortcut strip");
  const count = sent.length;
  await touch(page, [
    [{ x: stripBox.x + stripBox.width - 10, y: stripBox.y + 20 }],
    [{ x: stripBox.x + stripBox.width / 2, y: stripBox.y + 20 }],
    [{ x: stripBox.x + 10, y: stripBox.y + 20 }],
    [],
  ]);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  expect(sent.length).toBe(count);
  if (page.context().browser()?.browserType().name() === "chromium")
    expect(await strip.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await controls.getByTestId("terminal-font-larger").tap();
  await expect(surface).toHaveAttribute("data-font-size", "14");
  await expect(input).toBeFocused();
  await touch(page, [
    [
      { x: x - 40, y },
      { x: x + 40, y },
    ],
    [
      { x: x - 60, y },
      { x: x + 60, y },
    ],
    [
      { x: x - 80, y },
      { x: x + 80, y },
    ],
    [],
  ]);
  await expect
    .poll(async () => Number(await surface.getAttribute("data-font-size")))
    .toBeGreaterThan(14);
  expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);
  await controls.getByTestId("terminal-font-reset").tap();
  await expect(surface).toHaveAttribute("data-font-size", "13");
  await controls.getByTestId("terminal-font-larger").tap();
  await page.screenshot({ path: testInfo.outputPath("terminal-mobile-zoom.png") });
  await page.reload();
  await expect(surface).toHaveAttribute("data-font-size", "14");
  const current = await apiGet<{ pid: number; status: string }>(
    request,
    `/terminals/${terminal.id}`,
  );
  expect(current).toMatchObject({ pid: terminal.pid, status: "running" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("terminal keeps useful canvas space in a small landscape keyboard viewport", async ({
  page,
  request,
}) => {
  const terminal = await apiPost<{ id: string }>(request, "/terminals", {
    kind: "shell",
    host: null,
  });
  await gotoView(page, "terminals");
  await page.goto(`/terminals/${terminal.id}?project=all`);
  await expect(page.getByTestId("terminal-surface")).toBeVisible();
  await page.setViewportSize({ width: 844, height: 240 });
  await expect
    .poll(async () => (await page.getByTestId("terminal-viewport").boundingBox())?.height ?? 0)
    .toBeGreaterThan(60);
  const controls = await page.getByTestId("terminal-touch-controls").boundingBox();
  expect(controls ? controls.y + controls.height : 10000).toBeLessThanOrEqual(240);
});

test("chat swipes independently and switching back preserves the terminal", async ({
  page,
  request,
}) => {
  const terminal = await apiPost<{ id: string; pid: number }>(request, "/terminals", {
    kind: "shell",
    host: null,
  });
  await page.route("**/api/chat/models?**", (route) =>
    route.fulfill({ json: { models: [], warning: null } }),
  );
  await page.route("**/api/chat/stream", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: `data: ${JSON.stringify({ type: "text", text: "A readable mobile answer.\n\n".repeat(80) })}\n\ndata: {"type":"done"}\n\n`,
    }),
  );
  await gotoView(page, "terminals");
  await page.goto(`/terminals/${terminal.id}?project=all`);
  await expect(page.getByTestId("terminal-surface")).toBeVisible();
  await page.getByTestId("chat-open-button").tap();
  const sheet = page.getByTestId("mobile-chat-sheet");
  await sheet.getByTestId("chat-input").fill("Give a long answer");
  await sheet.getByTestId("chat-send-button").tap();
  await expect(sheet.getByTestId("chat-message-content").last()).toContainText(
    "A readable mobile answer.",
  );
  const viewport = sheet.getByTestId("chat-messages");
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
  const before = await viewport.evaluate((element) => element.scrollTop);
  const box = await viewport.boundingBox();
  if (!box) throw new Error("Missing chat viewport");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 3;
  await touch(page, [[{ x, y }], [{ x, y: y + 30 }], [{ x, y: y + 70 }], [{ x, y: y + 120 }], []]);
  // WebKit synthetic touch fixtures do not run native browser panning.
  if (page.context().browser()?.browserType().name() === "chromium") {
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeLessThan(before);
    const session = await page.context().newCDPSession(page);
    try {
      await touch(page, [
        [
          { x: x - 40, y },
          { x: x + 40, y },
        ],
        [
          { x: x - 50, y },
          { x: x + 50, y },
        ],
        [
          { x: x - 60, y },
          { x: x + 60, y },
        ],
        [
          { x: x - 70, y },
          { x: x + 70, y },
        ],
        [
          { x: x - 80, y },
          { x: x + 80, y },
        ],
        [],
      ]);
      await expect
        .poll(() => page.evaluate(() => window.visualViewport?.scale ?? 1))
        .toBeGreaterThan(1);
      await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
    } finally {
      await session.detach();
    }
  }
  expect(await viewport.evaluate((element) => getComputedStyle(element).touchAction)).toBe("auto");
  await sheet.getByTestId("chat-close-button").tap();
  await expect(page.getByTestId("terminal-surface")).toBeVisible();
  const current = await apiGet<{ pid: number; status: string }>(
    request,
    `/terminals/${terminal.id}`,
  );
  expect(current).toMatchObject({ pid: terminal.pid, status: "running" });
});

test("Android chat keeps a long draft and send control above the software keyboard", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const viewport = new EventTarget();
    Object.assign(viewport, { height: 844, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, "visualViewport", { value: viewport });
    Object.assign(window, {
      setKeyboardHeight: (height: number) => {
        Object.assign(viewport, { height });
        viewport.dispatchEvent(new Event("resize"));
      },
    });
  });
  await page.route("**/api/chat/models?**", (route) =>
    route.fulfill({ json: { models: [], warning: null } }),
  );
  await gotoView(page, "tasks");
  await page.getByTestId("chat-open-button").tap();
  const sheet = page.getByTestId("mobile-chat-sheet");
  const input = sheet.getByTestId("chat-input");
  await input.fill("A long draft\n".repeat(30));
  await page.evaluate(() =>
    (window as unknown as { setKeyboardHeight: (height: number) => void }).setKeyboardHeight(360),
  );
  const send = sheet.getByTestId("chat-send-button");
  await expect
    .poll(async () => {
      const box = await send.boundingBox();
      return box ? box.y + box.height : 10000;
    })
    .toBeLessThanOrEqual(360);
  const messages = sheet.getByTestId("chat-messages");
  expect((await messages.boundingBox())?.height).toBeGreaterThan(40);
  await expect(input).toHaveValue("A long draft\n".repeat(30));
  for (const height of [240, 200]) {
    await page.evaluate(
      (height) =>
        (window as unknown as { setKeyboardHeight: (height: number) => void }).setKeyboardHeight(
          height,
        ),
      height,
    );
    await expect
      .poll(async () => {
        const box = await send.boundingBox();
        return box ? box.y + box.height : 10000;
      })
      .toBeLessThanOrEqual(height);
    expect((await messages.boundingBox())?.height).toBeGreaterThan(20);
    await expect(input).toHaveValue("A long draft\n".repeat(30));
  }
});
