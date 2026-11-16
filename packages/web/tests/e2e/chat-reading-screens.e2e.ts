import { ChatSettingsSchema, type ChatThread } from "@orc/core/chat";
import { expect, test } from "@playwright/test";
import { settingsSection } from "./_chat-ui";
import { gotoView, repoRoot } from "./_helpers";
import { HOME, mockSessionHome } from "./_session-home-demo";

// Docs screenshots for chat reading and Settings → Appearance. Set
// ORC_CAPTURE_READING_SCREENS=1 to refresh docs/public/screens.
const CAPTURE = process.env.ORC_CAPTURE_READING_SCREENS === "1";

const ANSWER = `## Why the totals drift

The subtotal is multiplied **before** the discount, so fractions of a cent pile up across line items. Rounding once at the money boundary fixes it without touching the tax rules.

| Step | Before | After |
|---|---|---|
| Line items | 3 × 19.99 = 59.97 | 59.97 |
| 15% discount | 50.9745 | 50.97 |
| Tax (8.25%) | 55.18 | 55.18 |

### The change

- Round in \`toCents()\` only, never inside the loop.
- Keep the discount as a percentage until checkout.
- Add a regression test for three discounted items.

\`\`\`ts
export const toCents = (amount: number) => Math.round(amount * 100) / 100;
\`\`\`

The cart suite passes, and two snapshots now show whole cents.`;

for (const width of [1440, 390]) {
  test(`chat reading and appearance screenshots at ${width}px`, async ({ page }, testInfo) => {
    const now = Date.now();
    const suffix = width === 1440 ? "desktop" : "phone";
    const shot = async (name: string) => {
      await page.screenshot({
        // Only the desktop variants are shown by a docs page. Keep the phone
        // captures as review artifacts in the git-ignored test output so a docs
        // refresh cannot commit an image nothing links to.
        path:
          CAPTURE && width === 1440
            ? `${repoRoot()}/docs/public/screens/${name}-${suffix}.png`
            : testInfo.outputPath(`${name}-${suffix}.png`),
        animations: "disabled",
      });
    };
    const thread: ChatThread = {
      id: HOME.chatA,
      title: "Round cart totals to cents",
      config: ChatSettingsSchema.parse({ agent: "claude" }),
      cwd: "/home/demo/acme-shop",
      host: null,
      runtimeId: null,
      sourceId: null,
      backend: "claude-code",
      updatedAt: now - 5 * 60_000,
      messages: [
        {
          id: `${HOME.chatA}-q`,
          role: "user",
          content: "Cart totals show fractions of a cent. Why, and how do we fix it?",
          timestamp: now - 8 * 60_000,
        },
        { id: `${HOME.chatA}-a`, role: "assistant", content: ANSWER, timestamp: now - 5 * 60_000 },
      ],
    };
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(() => localStorage.setItem("orc_theme", "dark"));
    await mockSessionHome(page, now);
    await page.route(`**/api/chat/threads/${HOME.chatA}`, (route) =>
      route.fulfill({ json: thread }),
    );

    await page.goto(`/chat?project=all&chatThread=${HOME.chatA}`);
    const message = page.getByTestId("chat-message-content").last();
    await expect(message).toContainText("two snapshots now show whole cents");
    await expect(message.locator("table")).toBeVisible();
    await expect(message.locator("h2")).toHaveText("Why the totals drift");
    await expect(page.locator("html")).toHaveAttribute("data-chat-width", "wide");
    await expect(page.locator("html")).toHaveAttribute(
      "data-chat-text",
      width === 1440 ? "large" : "default",
    );
    await message.locator("h2").scrollIntoViewIfNeeded();
    await shot("chat-reading");

    await gotoView(page, "settings");
    await settingsSection(page, "appearance");
    await expect(page.getByTestId("settings-chatFont-interface")).toBeVisible();
    await shot("settings-appearance");
  });
}
