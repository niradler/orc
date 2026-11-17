import { expect, type Page, type Route, test } from "@playwright/test";
import { gotoView } from "./_helpers";

test.use({
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
  permissions: ["microphone"],
});

async function openComposer(page: Page, available: boolean) {
  await page.route("**/api/chat/models?**", (route) =>
    route.fulfill({ json: { models: [], warning: null } }),
  );
  await page.route("**/api/speech/status", (route) => route.fulfill({ json: { available } }));
  await gotoView(page, "tasks");
  await page.goto("/tasks?project=all&chat=full");
  await expect(page.getByTestId("chat-input")).toBeEnabled();
}

async function shoot(page: Page, name: string) {
  const dir = process.env.DICTATION_SCREENS;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

async function expectNoHorizontalScroll(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
}

for (const [label, size] of [
  ["desktop", { width: 1440, height: 900 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  test.describe(`dictation at ${size.width}px`, () => {
    test.use({ viewport: size, hasTouch: label === "phone" });

    test("unconfigured speech explains how to turn dictation on", async ({ page }) => {
      await openComposer(page, false);
      await shoot(page, `idle-unconfigured-${label}`);
      const mic = page.getByTestId("chat-dictation-button");
      await expect(mic).toHaveAttribute("data-available", "false");
      await mic.click();
      await expect(page.getByTestId("chat-dictation-unavailable")).toHaveText(
        "Dictation off · Set up",
      );
      await shoot(page, `unconfigured-${label}`);
      await expectNoHorizontalScroll(page);
      await expect(page.getByTestId("chat-dictation-pill")).toHaveCount(0);
    });

    test("record, transcribe and insert at the cursor without sending", async ({ page }) => {
      await openComposer(page, true);
      const chatPosts: string[] = [];
      page.on("request", (request) => {
        if (request.method() === "POST" && /\/api\/chat(\/uploads)?$/.test(request.url()))
          chatPosts.push(request.url());
      });
      let release: (() => void) | undefined;
      let uploaded = 0;
      await page.route("**/api/speech/transcribe", async (route: Route) => {
        uploaded = route.request().postDataBuffer()?.length ?? 0;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        await route.fulfill({ json: { text: "login" } });
      });
      const input = page.getByTestId("chat-input");
      await input.fill("fix the bug");
      await input.evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(7, 7));
      await shoot(page, `idle-${label}`);
      const mic = page.getByTestId("chat-dictation-button");
      await expect(mic).toHaveAttribute("data-available", "true");
      if (label === "phone") expect((await mic.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await mic.click();

      const pill = page.getByTestId("chat-dictation-pill");
      await expect(pill).toHaveAttribute("data-phase", "recording", { timeout: 20_000 });
      await expect(page.getByTestId("chat-dictation-elapsed")).toHaveText(/0:0[1-9]/, {
        timeout: 5_000,
      });
      await expect
        .poll(async () =>
          Number(await page.getByTestId("chat-dictation-level").getAttribute("data-level")),
        )
        .toBeGreaterThan(0);
      await expect(page.getByTestId("chat-send-button")).toBeDisabled();
      if (label === "phone")
        for (const id of ["chat-dictation-cancel", "chat-dictation-stop"])
          expect((await page.getByTestId(id).boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await expectNoHorizontalScroll(page);
      await shoot(page, `recording-${label}`);

      await page.getByTestId("chat-dictation-stop").click();
      await expect(pill).toHaveAttribute("data-phase", "transcribing");
      await expect(page.getByTestId("chat-send-button")).toBeDisabled();
      if (label === "desktop") await input.press("Enter");
      await shoot(page, `transcribing-${label}`);
      await expect.poll(() => release !== undefined).toBe(true);
      expect(uploaded).toBeGreaterThan(1000);
      release?.();

      await expect(input).toHaveValue("fix the login bug");
      await expect(pill).toHaveCount(0);
      await expect(input).toBeFocused();
      expect(await input.evaluate((field: HTMLTextAreaElement) => field.selectionStart)).toBe(13);
      await expect(page.getByTestId("chat-send-button")).toBeEnabled();
      expect(chatPosts).toEqual([]);
    });

    test("the shortcut starts and Escape discards the recording", async ({ page }) => {
      await openComposer(page, true);
      let transcribed = false;
      await page.route("**/api/speech/transcribe", (route) => {
        transcribed = true;
        return route.fulfill({ json: { text: "nope" } });
      });
      const input = page.getByTestId("chat-input");
      await input.fill("keep this");
      await input.press("ControlOrMeta+Shift+D");
      await expect(page.getByTestId("chat-dictation-pill")).toHaveAttribute(
        "data-phase",
        "recording",
        { timeout: 20_000 },
      );
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("chat-dictation-pill")).toHaveCount(0);
      await expect(input).toHaveValue("keep this");
      expect(transcribed).toBe(false);
    });

    test("a blocked microphone says how to fix it and offers a retry", async ({ page }) => {
      await page.addInitScript(() => {
        navigator.mediaDevices.getUserMedia = () =>
          Promise.reject(new DOMException("Permission denied", "NotAllowedError"));
      });
      await openComposer(page, true);
      await page.getByTestId("chat-dictation-button").click();
      await expect(page.getByTestId("chat-dictation-pill")).toHaveAttribute("data-phase", "error");
      await expect(page.getByTestId("chat-dictation-error")).toContainText("Microphone blocked");
      await expect(page.getByTestId("chat-dictation-retry")).toBeVisible();
      await expectNoHorizontalScroll(page);
      await shoot(page, `denied-${label}`);
      await page.getByTestId("chat-dictation-cancel").click();
      await expect(page.getByTestId("chat-dictation-pill")).toHaveCount(0);
    });
  });
}
