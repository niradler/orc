import { expect, test } from "@playwright/test";
import { settingsSection } from "./_chat-ui";
import { gotoView } from "./_helpers";

/** Settings → General → Voice picks the microphone for dictation and voice mode.
 *  The choice is per-browser; fake media devices stand in for a multi-mic machine.
 *  Run: bun packages/web/scripts/run-e2e.ts settings-voice */

test.use({
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
  permissions: ["microphone"],
});

async function shoot(page: import("@playwright/test").Page, name: string) {
  const dir = process.env.VOICE_SCREENS;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

async function scrollToVoice(page: import("@playwright/test").Page) {
  await page.getByTestId("voice-settings").scrollIntoViewIfNeeded();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

test("voice settings list connected microphones and save the choice in this browser", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoView(page, "settings");
  await settingsSection(page, "voice");
  const select = page.getByTestId("settings-voice-input");
  await expect(select).toBeVisible();
  await expect(select).toHaveValue("");
  // System default plus the fake microphones; the "default" alias is not duplicated.
  await expect.poll(() => select.locator("option").count()).toBeGreaterThan(2);
  const values = await select
    .locator("option")
    .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
  expect(values[0]).toBe("");
  expect(new Set(values).size).toBe(values.length);
  await expect(page.getByTestId("settings-voice-unnamed")).toHaveCount(0);
  await scrollToVoice(page);
  await shoot(page, "voice-desktop-default");

  const deviceId = values[values.length - 1] ?? "";
  expect(deviceId).not.toBe("");
  await select.selectOption(deviceId);
  expect(await page.evaluate(() => localStorage.getItem("orc_voice_input_device"))).toBe(deviceId);
  await shoot(page, "voice-desktop-selected");

  // A reload reads the saved choice back.
  await page.reload();
  await settingsSection(page, "voice");
  await expect(page.getByTestId("settings-voice-input")).toHaveValue(deviceId);

  // The help icon explains scope and permissions on focus, hover and tap.
  // Scroll it into view first: Radix dismisses tooltips on scroll, and the
  // scroll from focus()/click() would otherwise close the just-opened popover.
  const help = page.getByTestId("settings-voice-help");
  await help.scrollIntoViewIfNeeded();
  // Scroll events dispatch in the next rendering step; let them land before
  // opening, or the content's scroll dismissal closes the fresh popover.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await help.focus();
  await expect(page.getByTestId("settings-voice-help-content")).toBeVisible();
  await expect(page.getByTestId("settings-voice-help-content")).toContainText("System default");
  await shoot(page, "voice-desktop-help");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("settings-voice-help-content")).toHaveCount(0);
  await help.hover();
  await expect(page.getByTestId("settings-voice-help-content")).toBeVisible();
  await page.mouse.move(0, 0);
  await help.blur();
  await expect(page.getByTestId("settings-voice-help-content")).toHaveCount(0);

  await page.getByTestId("settings-voice-input").selectOption("");
  expect(await page.evaluate(() => localStorage.getItem("orc_voice_input_device"))).toBeNull();
});

test("a disconnected selection stays visible and warns about the fallback", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await gotoView(page, "settings");
  await page.evaluate(() => localStorage.setItem("orc_voice_input_device", "unplugged-mic"));
  await page.reload();
  await settingsSection(page, "voice");
  const select = page.getByTestId("settings-voice-input");
  await expect(select).toHaveValue("unplugged-mic");
  await expect(select.locator("option:checked")).toHaveText("Disconnected microphone");
  await expect(page.getByTestId("settings-voice-disconnected")).toBeVisible();
  await scrollToVoice(page);
  await shoot(page, "voice-desktop-disconnected");
  await select.selectOption("");
  await expect(page.getByTestId("settings-voice-disconnected")).toHaveCount(0);
});

test("voice settings are reachable and usable on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoView(page, "settings");
  await settingsSection(page, "voice");
  const select = page.getByTestId("settings-voice-input");
  await expect(select).toBeVisible();
  expect((await select.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await expect(page.getByTestId("settings-speech-language")).toBeVisible();
  await expect.poll(() => select.locator("option").count()).toBeGreaterThan(1);
  await scrollToVoice(page);
  await shoot(page, "voice-phone");
  const deviceId = await select
    .locator("option")
    .last()
    .evaluate((option) => (option as HTMLOptionElement).value);
  await select.selectOption(deviceId);
  expect(await page.evaluate(() => localStorage.getItem("orc_voice_input_device"))).toBe(deviceId);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await select.selectOption("");
});

test("voice help opens on tap on a phone and stays in the viewport", async ({ browser }) => {
  const context = await browser.newContext({
    hasTouch: true,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  try {
    await gotoView(page, "settings");
    await settingsSection(page, "voice");
    await page.getByTestId("settings-voice-help").tap();
    const content = page.getByTestId("settings-voice-help-content");
    await expect(content).toBeVisible();
    const bounds = await content.boundingBox();
    if (!bounds) throw new Error("Help content has no visible bounds");
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    await page.getByTestId("settings-voice-help").tap();
    await expect(content).toHaveCount(0);
  } finally {
    await context.close();
  }
});

const CATALOG_VOICES = [
  { id: "af_heart", name: "Heart", language: "en" },
  { id: "af_sky", name: "Sky", language: "en" },
];

test("speech defaults save the language and a catalog voice on the server", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const state = { language: "", voice: "" };
  let saved: { language?: string; voice?: string } | null = null;
  await page.route("**/api/speech/settings", (route) => {
    if (route.request().method() === "PATCH") {
      saved = route.request().postDataJSON() as { language?: string; voice?: string };
      Object.assign(state, saved);
    }
    return route.fulfill({
      json: { ...state, voices: CATALOG_VOICES, voice_source: "provider" },
    });
  });
  await gotoView(page, "settings");
  await settingsSection(page, "voice");
  const language = page.getByTestId("settings-speech-language");
  await expect(language).toBeVisible();
  await expect(language).toHaveValue("");
  await language.selectOption("he");
  const voice = page.getByTestId("settings-speech-voice");
  await expect(voice.locator("option")).toHaveCount(3);
  await voice.selectOption("af_heart");
  const save = page.getByTestId("settings-speech-save");
  await expect(save).toBeEnabled();
  await scrollToVoice(page);
  await shoot(page, "voice-desktop-speech");
  await save.click();
  await expect(page.getByTestId("settings-speech-feedback")).toBeVisible();
  expect(saved).toEqual({ language: "he", voice: "af_heart" });
  await expect(save).toBeDisabled();
});

test("without a voice catalog the reply voice is a free-text id", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const state = { language: "", voice: "" };
  let saved: { language?: string; voice?: string } | null = null;
  await page.route("**/api/speech/settings", (route) => {
    if (route.request().method() === "PATCH") {
      saved = route.request().postDataJSON() as { language?: string; voice?: string };
      Object.assign(state, saved);
    }
    return route.fulfill({ json: { ...state, voices: [], voice_source: "none" } });
  });
  await gotoView(page, "settings");
  await settingsSection(page, "voice");
  const voice = page.getByTestId("settings-speech-voice");
  await expect(voice).toBeVisible();
  expect(await voice.evaluate((element) => element.tagName)).toBe("INPUT");
  await voice.fill("Cherry");
  await page.getByTestId("settings-speech-save").click();
  await expect(page.getByTestId("settings-speech-feedback")).toBeVisible();
  expect(saved).toEqual({ language: "", voice: "Cherry" });
});
