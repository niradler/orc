import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devices, expect, type Page, type WebSocketRoute } from "@playwright/test";
import { apiGet, apiPost, gotoView } from "./_helpers";
import { test } from "./_terminal-fixture";

test.use({ ...devices["Pixel 7"], viewport: { width: 390, height: 844 } });

async function touch(page: Page, points: { x: number; y: number }[][], holdMs = 0) {
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
      // A long press: the finger rests after landing.
      if (index === 0 && holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
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
  await page.keyboard.insertText(command);
  await input.evaluate((element) => {
    element.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertLineBreak",
      }),
    );
  });
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

test("phone keyboard input reaches the shell once, as it is typed", async ({ page, request }) => {
  test.skip(
    page.context().browser()?.browserType().name() !== "chromium",
    "IME composition is driven through CDP",
  );
  const terminal = await apiPost<{ id: string }>(request, "/terminals", {
    kind: "shell",
    host: null,
  });
  const sent: string[] = [];
  page.on("websocket", (socket) => {
    if (!socket.url().includes(`/terminals/${terminal.id}/ws`)) return;
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") sent.push(payload.toString());
    });
  });
  await gotoView(page, "terminals");
  await page.goto(`/terminals/${terminal.id}?project=all`);
  await page.getByTestId("terminal-keyboard-show").tap();
  const input = page.locator("textarea[aria-label='Terminal input']").first();
  await expect(input).toBeFocused();
  const typed = () => sent.join("");
  const cdp = await page.context().newCDPSession(page);
  try {
    // Gboard: each letter updates the composition, space commits the word.
    const compose = (text: string) =>
      cdp.send("Input.imeSetComposition", {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      });
    await compose("g");
    await expect.poll(typed).toBe("g");
    await compose("go");
    await expect.poll(typed).toBe("go");
    await cdp.send("Input.insertText", { text: "go" });
    await cdp.send("Input.insertText", { text: " " });
    await expect.poll(typed).toBe("go ");
    // Autocorrect rewrites the word being composed.
    await compose("teh");
    await compose("the");
    await cdp.send("Input.insertText", { text: "the" });
    await expect.poll(typed).toBe("go teh\x7f\x7fhe");
    // Backspace mid-word and on an empty line both reach the shell.
    await page.keyboard.press("Backspace");
    await expect.poll(typed).toBe("go teh\x7f\x7fhe\x7f");
  } finally {
    await cdp.detach();
  }
  // A hardware or Bluetooth keyboard types each key exactly once.
  sent.length = 0;
  await page.keyboard.type("ls -a");
  await page.keyboard.press("Enter");
  await expect.poll(typed).toBe("ls -a\r");
  await page.waitForTimeout(300);
  expect(typed()).toBe("ls -a\r");
});

test("one tap on the terminal opens the keyboard and Android enter submits the line", async ({
  page,
  request,
}) => {
  test.skip(
    page.context().browser()?.browserType().name() !== "chromium",
    "Android key events are driven through CDP",
  );
  const terminal = await apiPost<{ id: string }>(request, "/terminals", {
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
  const canvas = page.locator("[data-testid='terminal-surface'] canvas").first();
  await expect(canvas).toBeVisible();
  await expect.poll(() => output.length).toBeGreaterThan(0);
  const input = page.locator("textarea[aria-label='Terminal input']").first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Missing terminal canvas");
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  // The surface's padding and the slack below the last row are outside the canvas; a tap
  // there must still reach the terminal input, not the surrounding contenteditable root.
  const surface = await page.getByTestId("terminal-surface").first().boundingBox();
  if (!surface) throw new Error("Missing terminal surface");
  await touch(page, [[{ x: center.x, y: surface.y + surface.height - 3 }], []]);
  await expect(input).toBeFocused();
  await page.locator("body").evaluate(() => (document.activeElement as HTMLElement).blur());
  await touch(page, [[center], []]);
  await expect(input).toBeFocused();
  await page.waitForTimeout(500);
  await expect(input).toBeFocused();
  const typed = () => sent.join("");
  const cdp = await page.context().newCDPSession(page);
  // Soft keyboards report Enter and Backspace with an empty code, which ghostty cannot map.
  const androidKey = async (key: string, keyCode: number, text?: string) => {
    const event = { key, code: "", windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      ...event,
      ...(text ? { text, unmodifiedText: text } : {}),
    });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
  };
  try {
    for (const word of ["e", "ec", "ech", "echo"])
      await cdp.send("Input.imeSetComposition", {
        text: word,
        selectionStart: word.length,
        selectionEnd: word.length,
      });
    await cdp.send("Input.insertText", { text: "echo" });
    await cdp.send("Input.insertText", { text: " ONE_TAPX" });
    await androidKey("Backspace", 8);
    await expect.poll(typed).toBe("echo ONE_TAPX\x7f");
    await androidKey("Enter", 13, "\r");
    await expect.poll(typed).toBe("echo ONE_TAPX\x7f\r");
    await expect.poll(() => output).toContain("ONE_TAP");
    // The next line starts clean and Enter on an empty prompt still submits.
    await cdp.send("Input.insertText", { text: "echo SECOND" });
    await androidKey("Enter", 13, "\r");
    await androidKey("Enter", 13, "\r");
    await expect.poll(typed).toBe("echo ONE_TAPX\x7f\recho SECOND\r\r");
    await expect.poll(() => output).toContain("SECOND");
    // Backspace with nothing typed on the phone still erases what the shell has.
    sent.length = 0;
    await cdp.send("Input.insertText", { text: "ab" });
    await androidKey("Enter", 13, "\r");
    await androidKey("Backspace", 8);
    await expect.poll(typed).toBe("ab\r\x7f");
  } finally {
    await cdp.detach();
  }
});

test("sticky ctrl from the key bar sends the next typed letter as a control key", async ({
  page,
  request,
}) => {
  const terminal = await apiPost<{ id: string }>(request, "/terminals", {
    kind: "shell",
    host: null,
  });
  const sent: string[] = [];
  page.on("websocket", (socket) => {
    if (!socket.url().includes(`/terminals/${terminal.id}/ws`)) return;
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") sent.push(payload.toString());
    });
  });
  await gotoView(page, "terminals");
  await page.goto(`/terminals/${terminal.id}?project=all`);
  await page.getByTestId("terminal-keyboard-show").tap();
  const input = page.locator("textarea[aria-label='Terminal input']").first();
  await expect(input).toBeFocused();
  const ctrl = page.getByTestId("terminal-ctrl");
  await ctrl.tap();
  await expect(ctrl).toHaveAttribute("aria-pressed", "true");
  await expect(input).toBeFocused();
  await page.keyboard.insertText("l");
  await expect.poll(() => sent.join("")).toBe("\f");
  await expect(ctrl).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.insertText("l");
  await expect.poll(() => sent.join("")).toBe("\fl");
});

// Stands in for a full-screen program: "tracking" switches on the modes Codex 0.164 does,
// "alternate" only the alternate screen (less, man), and "lines" fills the scrollback.
const SCREEN_SCRIPT = `
const mode = process.argv[2];
if (mode === "lines") {
  for (let i = 0; i < 200; i++) console.log("LINE_" + i);
  process.exit(0);
}
if (mode === "wrap") {
  console.log("WRAP_" + "x".repeat(300) + "_END");
  process.exit(0);
}
const on = mode === "tracking" ? "<ESC>[?1049h<ESC>[?1007l<ESC>[?1000h<ESC>[?1006h" : "<ESC>[?1049h";
process.stdout.write(on + "SCREEN_READY");
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", (data) => {
  if (!data.includes(3)) return;
  process.stdout.write("<ESC>[?1006l<ESC>[?1000l<ESC>[?1049l");
  process.exit(0);
});
`;

test("touch swipes scroll full-screen programs and PgUp/PgDn page the terminal", async ({
  page,
  request,
}) => {
  test.skip(
    page.context().browser()?.browserType().name() !== "chromium",
    "Touch gestures are driven through CDP",
  );
  const dir = mkdtempSync(join(tmpdir(), "orc-screen-"));
  const script = join(dir, "screen.js");
  writeFileSync(script, SCREEN_SCRIPT.replaceAll("<ESC>", "\x1b"));
  const terminal = await apiPost<{ id: string }>(request, "/terminals", {
    kind: "shell",
    host: null,
  });
  const sent: string[] = [];
  let output = "";
  let toPage: WebSocketRoute | undefined;
  // Proxied so the test can play program output to the page: Windows ConPTY drops the mouse
  // mode sequences a program writes, so they never reach the browser through the PTY there.
  await page.routeWebSocket(`**/terminals/${terminal.id}/ws**`, (ws) => {
    toPage = ws;
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      if (typeof message !== "string") sent.push(message.toString());
      server.send(message);
    });
    server.onMessage((message) => {
      output += message.toString();
      ws.send(message);
    });
  });
  await gotoView(page, "terminals");
  await page.goto(`/terminals/${terminal.id}?project=all`);
  const surface = page.getByTestId("terminal-surface").first();
  const canvas = surface.locator("canvas").first();
  await expect(canvas).toBeVisible();
  await expect.poll(() => output.length).toBeGreaterThan(0);
  const input = page.locator("textarea[aria-label='Terminal input']").first();
  const run = async (mode: string, ready: string) => {
    await input.focus();
    await page.keyboard.type(`bun "${script}" ${mode}`);
    await page.keyboard.press("Enter");
    await expect.poll(() => output, { timeout: 15_000 }).toContain(ready);
  };
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Missing terminal canvas");
  const x = box.x + box.width / 2;
  const top = box.y + box.height / 3;
  // A slow swipe: 20 finger moves of 5px, each far below one wheel step on its own.
  const swipe = (direction: 1 | -1) => {
    const start = direction > 0 ? top : top + 100;
    return touch(page, [
      ...Array.from({ length: 21 }, (_, index) => [{ x, y: start + direction * index * 5 }]),
      [],
    ]);
  };
  const typed = () => sent.join("");
  const scrollOffset = async () => Number(await surface.getAttribute("data-scroll-offset"));

  // At a shell prompt PgUp/PgDn page the scrollback instead of editing the line.
  await run("lines", "LINE_199");
  sent.length = 0;
  await page.getByRole("button", { name: "Page up" }).tap();
  await expect.poll(scrollOffset).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Page down" }).tap();
  await expect.poll(scrollOffset).toBe(0);
  expect(typed()).toBe("");

  // Codex tracks the mouse: a swipe becomes SGR wheel reports, never history arrows.
  await run("tracking", "SCREEN_READY");
  toPage?.send(Buffer.from("\x1b[?1007l\x1b[?1000h\x1b[?1006h"));
  const reports = () => typed().replace(/;\d+;\d+M/g, ";M");
  sent.length = 0;
  await swipe(1);
  await expect.poll(reports).toBe("\x1b[<64;M".repeat(3));
  sent.length = 0;
  await swipe(-1);
  await expect.poll(reports).toBe("\x1b[<65;M".repeat(3));
  sent.length = 0;
  await page.getByRole("button", { name: "Page up" }).tap();
  await page.getByRole("button", { name: "Page down" }).tap();
  await expect.poll(typed).toBe("\x1b[5~\x1b[6~");
  await page.getByRole("button", { name: "Interrupt command" }).tap();
  toPage?.send(Buffer.from("\x1b[?1006l\x1b[?1000l\x1b[?1007h"));

  // Without tracking, a full-screen program gets arrow keys, as with alternate scroll in xterm.
  output = "";
  await run("alternate", "SCREEN_READY");
  sent.length = 0;
  await swipe(1);
  await expect.poll(typed).toBe("\x1b[A".repeat(3));
  await page.getByRole("button", { name: "Interrupt command" }).tap();
});

test("a long press reaches selectable text over the canvas and the text view copies it all", async ({
  page,
  request,
}) => {
  test.skip(
    page.context().browser()?.browserType().name() !== "chromium",
    "Touch gestures are driven through CDP",
  );
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const dir = mkdtempSync(join(tmpdir(), "orc-screen-"));
  const script = join(dir, "screen.js");
  writeFileSync(script, SCREEN_SCRIPT.replaceAll("<ESC>", "\x1b"));
  const terminal = await apiPost<{ id: string }>(request, "/terminals", {
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
  const surface = page.getByTestId("terminal-surface").first();
  const canvas = surface.locator("canvas").first();
  await expect(canvas).toBeVisible();
  await expect.poll(() => output.length).toBeGreaterThan(0);
  const input = page.locator("textarea[aria-label='Terminal input']").first();
  await input.focus();
  await page.keyboard.type(`bun "${script}" lines`);
  await page.keyboard.press("Enter");
  await expect.poll(() => output, { timeout: 15_000 }).toContain("LINE_199");
  await page.keyboard.type(`bun "${script}" wrap`);
  await page.keyboard.press("Enter");
  await expect
    .poll(() => output.match(/x+/g)?.join("").length ?? 0, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(300);
  // The Windows clipboard turns line feeds into CRLF.
  const clipboard = async () =>
    (await page.evaluate(() => navigator.clipboard.readText())).replaceAll("\r\n", "\n");
  await page.evaluate(() => navigator.clipboard.writeText(""));

  const box = await canvas.boundingBox();
  if (!box) throw new Error("Missing terminal canvas");
  const layer = surface.getByTestId("terminal-text-layer");
  // The rows follow the output once it settles.
  await expect(layer).toContainText("_END");
  await input.blur();
  sent.length = 0;
  await expect(layer).toHaveAttribute("aria-hidden", "true");
  await expect(layer).toHaveCSS("color", "rgba(0, 0, 0, 0)");

  // Every row sits on its canvas row and every glyph on its cell.
  const geometry = await layer.evaluate((element, canvasBox) => {
    const rows = Array.from(element.children) as HTMLElement[];
    const line = rows.find((row) => /^LINE_\d{3}$/.test(row.textContent ?? ""));
    const text = line?.firstChild;
    const range = document.createRange();
    if (text) range.selectNodeContents(text);
    const box = element.getBoundingClientRect();
    return {
      offset: Math.max(
        Math.abs(box.x - canvasBox.x),
        Math.abs(box.y - canvasBox.y),
        Math.abs(box.width - canvasBox.width),
        Math.abs(box.height - canvasBox.height),
      ),
      rows: rows.length,
      rowTops: rows.map((row) => row.getBoundingClientRect().top - box.top),
      textWidth: range.getBoundingClientRect().width,
      wrapCols: rows.find((row) => row.textContent?.startsWith("WRAP_"))?.textContent?.length ?? 0,
    };
  }, box);
  const termRows = geometry.rows;
  const cellHeight = box.height / termRows;
  expect(geometry.offset).toBeLessThan(1);
  for (const [row, top] of geometry.rowTops.entries())
    expect(Math.abs(top - row * cellHeight)).toBeLessThan(1);
  // The output's first wrapped row fills every column.
  expect(geometry.wrapCols).toBeGreaterThan(10);
  const cellWidth = box.width / geometry.wrapCols;
  // "LINE_123" is 8 cells; letter spacing makes the font's advance match the canvas cells.
  expect(Math.abs(geometry.textWidth - 8 * cellWidth)).toBeLessThan(1.5);

  // A long press on text belongs to the browser: it is not taken over, so the platform's
  // own selection, handles and Copy toolbar can start, and the hidden input stays unfocused.
  const lineBox = await layer.evaluate((element) => {
    const row = Array.from(element.children).find((child) =>
      /^LINE_\d{3}$/.test(child.textContent ?? ""),
    );
    const rect = row?.getBoundingClientRect();
    return rect ? { x: rect.x, y: rect.y, height: rect.height } : null;
  });
  if (!lineBox) throw new Error("Missing a LINE_ row");
  const press = { x: lineBox.x + cellWidth * 2, y: lineBox.y + lineBox.height / 2 };
  await surface.evaluate((element) => {
    const events = { target: "", prevented: false };
    element.addEventListener("touchstart", (event) => {
      const target = event.target as Element;
      events.target = target.closest("[data-testid='terminal-text-layer']") ? "layer" : "root";
      // Read after every listener ran.
      setTimeout(() => {
        events.prevented = event.defaultPrevented;
      });
    });
    (window as unknown as { touchEvents: typeof events }).touchEvents = events;
  });
  await touch(page, [[press], []], 700);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { touchEvents: { target: string; prevented: boolean } }).touchEvents,
    ),
  ).toEqual({ target: "layer", prevented: false });
  await expect(input).not.toBeFocused();
  expect(sent.join("")).toBe("");

  // Copy gives the terminal's lines: rows stay rows, and a wrapped line comes back whole.
  await layer.evaluate((element) => {
    const rows = Array.from(element.children);
    const first = rows.findIndex((row) => /^LINE_\d{3}$/.test(row.textContent ?? ""));
    const range = document.createRange();
    range.setStart(rows[first] as Node, 0);
    range.setEnd(element, element.childNodes.length);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.execCommand("copy");
  });
  const copied = await clipboard();
  expect(copied).toMatch(/^LINE_\d{3}\nLINE_\d{3}\n/);
  expect(copied).toContain(`\nWRAP_${"x".repeat(300)}_END\n`);

  // A tap with text selected only dismisses the selection.
  await touch(page, [[press], []]);
  expect(await page.evaluate(() => document.getSelection()?.isCollapsed ?? true)).toBe(true);
  await expect(input).not.toBeFocused();
  expect(sent.join("")).toBe("");

  // A mouse keeps ghostty's own selection and clicks: the layer stops taking its hits.
  await page.mouse.move(press.x, press.y);
  await expect(layer).toHaveCSS("pointer-events", "none");

  await page.getByRole("button", { name: "Copy terminal text" }).tap();
  const sheet = page.getByTestId("terminal-text-sheet");
  await expect(sheet).toContainText("LINE_199");
  await sheet.getByRole("button", { name: "Copy all" }).tap();
  await expect(sheet.getByRole("button", { name: "Copied" })).toBeVisible();
  const all = await clipboard();
  expect(all).toContain("LINE_0\nLINE_1\n");
  expect(all).toContain("LINE_199");
});
