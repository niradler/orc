import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ChatSettingsSchema } from "@orc/core/chat";
import { devices, expect, test } from "@playwright/test";
import { API_SECRET, gotoView, repoRoot } from "./_helpers";

const defaults = ChatSettingsSchema.parse({});
const draft = "Keep this draft while choosing the workspace.\n".repeat(20);
const model = "a-long-model-name-for-a-narrow-keyboard-composer";
const artifacts = join(repoRoot(), ".claude/validation/chat-keyboard");
mkdirSync(artifacts, { recursive: true });
test.use({ ...devices["Pixel 7"], viewport: { width: 390, height: 844 } });

test.describe("phone keyboard composer", () => {
  for (const width of [320, 390]) {
    for (const theme of ["dark", "light"] as const) {
      test(`workspace controls remain reachable with a long draft at ${width}px ${theme}`, async ({
        page,
        request,
      }) => {
        await page.setViewportSize({ width, height: 844 });
        const settings = await request.patch("/api/settings", {
          headers: { Authorization: `Bearer ${API_SECRET}` },
          data: { theme, chat: { ...defaults, model } },
        });
        expect(settings.ok()).toBe(true);
        await page.route("**/api/chat/models?**", (route) =>
          route.fulfill({ json: { models: [], warning: null } }),
        );
        await page.route("**/api/ssh", (route) =>
          route.fulfill({ json: { host: null, hosts: ["lab"], supported: true } }),
        );
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
          localStorage.setItem(
            "orc_folder_history",
            JSON.stringify({
              local: { last: "/workspace/product", recent: ["/workspace/product"] },
            }),
          );
        });
        await gotoView(page, "tasks");
        await page.getByTestId("chat-open-button").tap();
        const sheet = page.getByTestId("mobile-chat-sheet");
        const input = sheet.getByTestId("chat-input");
        const send = sheet.getByTestId("chat-send-button");
        const actions = sheet.getByTestId("chat-workspace-actions");
        const selectors = sheet.getByTestId("chat-composer-selectors");
        await input.fill(draft);
        await expect(sheet.getByTestId("chat-model-button")).toContainText(model);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await page.evaluate(() => document.fonts.ready);
        await expect
          .poll(() =>
            sheet
              .getByTestId("chat-panel")
              .evaluate((element) => getComputedStyle(element).backgroundColor),
          )
          .toBe(theme === "dark" ? "rgb(0, 0, 0)" : "rgb(250, 250, 250)");
        await sheet.screenshot({
          path: join(artifacts, `phone-${width}-${theme}-keyboard-closed.png`),
        });
        for (const height of [240, 200]) {
          await page.evaluate(
            (height) =>
              (
                window as unknown as { setKeyboardHeight: (height: number) => void }
              ).setKeyboardHeight(height),
            height,
          );
          await expect.poll(async () => (await sheet.boundingBox())?.height).toBe(height);
          await actions.evaluate((element) => {
            element.scrollLeft = 0;
          });
          await sheet.screenshot({
            path: join(artifacts, `phone-${width}-${theme}-keyboard-${height}.png`),
          });
          await expect
            .poll(async () => (await sheet.getByTestId("chat-messages").boundingBox())?.height ?? 0)
            .toBeGreaterThan(20);
          const geometry = await actions.evaluate((element) => ({
            width: element.clientWidth,
            scrollWidth: element.scrollWidth,
            height: element.clientHeight,
          }));
          expect(geometry.scrollWidth).toBeGreaterThan(geometry.width);
          expect(geometry.height).toBeLessThanOrEqual(52);
          const selectorBox = await selectors.boundingBox();
          const actionBox = await actions.boundingBox();
          const sendBox = await send.boundingBox();
          if (!selectorBox || !actionBox || !sendBox)
            throw Error("Composer controls have no visible bounds");
          expect(Math.abs(selectorBox.y - actionBox.y)).toBeLessThan(8);
          expect(sendBox.y).toBeGreaterThanOrEqual(0);
          expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(height);
          expect(sendBox.x + sendBox.width).toBeLessThanOrEqual(width);
          const sendX = sendBox.x;
          if (height === 200) {
            await input.focus();
            const touch = await page.context().newCDPSession(page);
            try {
              const x = actionBox.x + actionBox.width - 8;
              const y = actionBox.y + 22;
              await touch.send("Input.dispatchTouchEvent", {
                type: "touchStart",
                touchPoints: [{ x, y }],
              });
              for (let step = 1; step <= 8; step++)
                await touch.send("Input.dispatchTouchEvent", {
                  type: "touchMove",
                  touchPoints: [{ x: x - step * 8, y }],
                });
              await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
            } finally {
              await touch.detach();
            }
            await expect
              .poll(() => actions.evaluate((element) => element.scrollLeft))
              .toBeGreaterThan(0);
            await expect(input).toBeFocused();
          }
          for (const id of [
            "chat-workspace-host",
            "chat-workspace-browse",
            "chat-workspace-recent",
            "chat-workspace-worktree",
          ]) {
            const control = sheet.getByTestId(id);
            await control.scrollIntoViewIfNeeded();
            await expect(control).toBeInViewport();
            const controlBox = await control.boundingBox();
            const fixedSendBox = await send.boundingBox();
            if (!controlBox || !fixedSendBox)
              throw Error("Workspace or send control lost its bounds");
            expect(controlBox.height).toBeGreaterThanOrEqual(44);
            expect(fixedSendBox.x).toBe(sendX);
          }
          await sheet.getByTestId("chat-workspace-host").focus();
          await page.keyboard.press("Tab");
          await expect(sheet.getByTestId("chat-workspace-browse")).toBeFocused();
          await expect(sheet.getByTestId("chat-workspace-browse")).toBeInViewport();
          const worktree = sheet.getByTestId("chat-workspace-worktree");
          await worktree.tap();
          await expect(worktree).toHaveAttribute("aria-pressed", height === 240 ? "true" : "false");
          await expect(input).toHaveValue(draft);
        }
        await page.evaluate(() =>
          (window as unknown as { setKeyboardHeight: (height: number) => void }).setKeyboardHeight(
            844,
          ),
        );
        await expect.poll(async () => (await sheet.boundingBox())?.height).toBe(844);
        await expect(input).toHaveValue(draft);
        await sheet.getByTestId("chat-close-button").tap();
        await page.getByTestId("chat-open-button").tap();
        await expect(page.getByTestId("mobile-chat-sheet").getByTestId("chat-input")).toHaveValue(
          draft,
        );
      });
    }
  }
});
