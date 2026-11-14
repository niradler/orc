import { expect, type Page, test } from "@playwright/test";
import { HOME, mockSessionHome } from "./_session-home-demo";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

/** CDP touch on Chromium, synthetic TouchEvents elsewhere (same as the terminal suite). */
async function touch(page: Page, points: { x: number; y: number }[][]) {
  if (page.context().browser()?.browserType().name() !== "chromium") {
    await page.evaluate((frames) => {
      const first = frames[0]?.[0];
      if (!first) throw new Error("Missing first touch");
      const target = document.elementFromPoint(first.x, first.y);
      if (!target) throw new Error("Missing touch target");
      for (const [index, touches] of frames.entries())
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
              changedTouches: touches.map((point, identifier) => ({
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
    // Explicit 8ms frame spacing makes flick velocity deterministic under load.
    const base = Date.now() / 1000;
    for (const [index, touches] of points.entries()) {
      await session.send("Input.dispatchTouchEvent", {
        type: index === 0 ? "touchStart" : touches.length ? "touchMove" : "touchEnd",
        touchPoints: touches.map((point, id) => ({ ...point, id })),
        timestamp: base + index * 0.008,
      });
    }
  } finally {
    await session.detach();
  }
}

async function swipe(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const steps = 8;
  const frames: { x: number; y: number }[][] = [];
  for (let step = 0; step <= steps; step++) {
    frames.push([
      {
        x: from.x + ((to.x - from.x) * step) / steps,
        y: from.y + ((to.y - from.y) * step) / steps,
      },
    ]);
  }
  frames.push([]);
  await touch(page, frames);
}

async function mockInspectorData(page: Page) {
  await page.route(`**/api/terminals/${HOME.terminal}/files?**`, (route) => {
    const path = new URL(route.request().url()).searchParams.get("path") ?? "";
    if (path === "package.json")
      return route.fulfill({
        json: {
          root: "/home/demo/acme-shop",
          path,
          entries: null,
          content: '{ "name": "acme-shop" }\n',
          binary: false,
          truncated: false,
        },
      });
    return route.fulfill({
      json: {
        root: "/home/demo/acme-shop",
        path,
        entries: [
          { name: "src", path: "src", directory: true },
          { name: "package.json", path: "package.json", directory: false },
        ],
        content: null,
        binary: false,
        truncated: false,
      },
    });
  });
  await page.route(`**/api/terminals/${HOME.terminal}/git/pulls/418`, (route) =>
    route.fulfill({
      json: {
        repo: "acme/shop",
        number: 418,
        title: "Round cart totals to cents",
        body: "Fixes the rounding drift at checkout.",
        state: "open",
        url: "https://github.com/acme/shop/pull/418",
        author: "demo",
        head: "a".repeat(40),
        branch: "fix/cart-rounding",
        base: "main",
        changed_files: 1,
        files: [
          {
            filename: "src/cart/total.ts",
            status: "modified",
            additions: 1,
            deletions: 1,
            patch:
              "@@ -1,3 +1,3 @@\n export function total(items: Item[]) {\n-  return items.reduce((sum, item) => sum + item.price, 0);\n+  return Math.round(items.reduce((sum, item) => sum + item.price, 0) * 100) / 100;\n }",
            patch_truncated: false,
          },
        ],
        comments: [],
        discussion: [],
        reviews: [],
        truncated: false,
      },
    }),
  );
}

test("swipe left opens the Sessions page, swipe right closes it, Back restores it", async ({
  page,
}) => {
  await mockSessionHome(page);
  await page.goto(`/chat?project=all&chatThread=${HOME.chatA}`);
  await expect(page.getByText("Here is the checkout plan.").first()).toBeVisible();
  await swipe(page, { x: 382, y: 420 }, { x: 90, y: 420 });
  const sessions = page.getByTestId("chat-sessions-dialog");
  await expect(sessions).toBeVisible();
  await expect(page).toHaveURL(/sessionList=show/);
  await expect(sessions.getByTestId("chat-session-list").locator("[data-history-id]")).toHaveCount(
    4,
  );
  // Let the slide-in settle so the close swipe starts on a resting page.
  await page.waitForTimeout(250);
  // The conversation stays mounted underneath.
  await swipe(page, { x: 60, y: 420 }, { x: 340, y: 420 });
  await expect(sessions).toBeHidden();
  await expect(page).not.toHaveURL(/sessionList=show/);
  await expect(page.getByText("Here is the checkout plan.").first()).toBeVisible();
  await page.goBack();
  await expect(sessions).toBeVisible();
});

test("swipe right from the left edge opens the Inspector and swipe left closes it", async ({
  page,
}) => {
  await mockSessionHome(page);
  await page.goto(`/chat?project=all&chatThread=${HOME.chatA}`);
  await expect(page.getByText("Here is the checkout plan.").first()).toBeVisible();
  await swipe(page, { x: 8, y: 420 }, { x: 320, y: 420 });
  const inspector = page.getByTestId("session-inspector");
  await expect(inspector).toBeVisible();
  await expect(page).toHaveURL(/inspector=overview/);
  await expect(inspector.getByTestId("session-inspector-branch")).toContainText(
    "fix/cart-rounding",
  );
  await expect(inspector.getByTestId("session-inspector-pull-request")).toContainText("#418");
  await page.waitForTimeout(250);
  await swipe(page, { x: 330, y: 420 }, { x: 60, y: 420 });
  await expect(inspector).toBeHidden();
  await expect(page).not.toHaveURL(/inspector=/);
});

test("pull down on the chat header opens the Terminal page and swipe up closes it", async ({
  page,
}) => {
  await mockSessionHome(page);
  await page.goto(`/chat?project=all&chatThread=${HOME.chatA}`);
  const header = page.locator(".chat-header");
  const box = await header.boundingBox();
  if (!box) throw new Error("Missing chat header");
  await swipe(
    page,
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 + 260 },
  );
  const terminal = page.getByTestId("session-drawer");
  await expect(terminal).toBeVisible();
  await expect(page).toHaveURL(/drawer=terminal/);
  await expect(terminal.getByTestId("session-drawer-open")).toBeVisible();
  await page.waitForTimeout(250);
  const terminalHeader = terminal.locator("header");
  const terminalBox = await terminalHeader.boundingBox();
  if (!terminalBox) throw new Error("Missing terminal header");
  await swipe(
    page,
    { x: terminalBox.x + terminalBox.width / 2, y: terminalBox.y + terminalBox.height / 2 },
    { x: terminalBox.x + terminalBox.width / 2, y: Math.max(8, terminalBox.y - 120) },
  );
  await expect(terminal).toBeHidden();
  await expect(page).not.toHaveURL(/drawer=terminal/);
});

test("interior horizontal swipes stay with the conversation", async ({ page }) => {
  await mockSessionHome(page);
  await page.goto(`/chat?project=all&chatThread=${HOME.chatA}`);
  await expect(page.getByText("Here is the checkout plan.").first()).toBeVisible();
  await swipe(page, { x: 200, y: 420 }, { x: 60, y: 420 });
  await expect(page.getByTestId("chat-sessions-dialog")).toBeHidden();
  await expect(page).not.toHaveURL(/sessionList=show/);
  await expect(page).not.toHaveURL(/inspector=/);
});

test("inspector PR and Files tabs are shareable URLs that restore on reload and close on Escape", async ({
  page,
}) => {
  await mockSessionHome(page);
  await mockInspectorData(page);
  await page.goto(`/chat?project=all&chatThread=${HOME.chatA}&inspector=pr`);
  const inspector = page.getByTestId("session-inspector");
  await expect(inspector).toBeVisible();
  await expect(inspector.getByTestId("session-inspector-tab-pr")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(inspector.getByTestId("pr-review-panel")).toContainText(
    "Round cart totals to cents",
  );
  await page.reload();
  await expect(inspector.getByTestId("pr-review-panel")).toBeVisible();
  await inspector.getByTestId("session-inspector-tab-files").click();
  await expect(page).toHaveURL(/inspector=files/);
  await expect(inspector.getByTestId("file-panel")).toBeVisible();
  await expect(
    inspector.getByTestId("file-entry").filter({ hasText: "package.json" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(inspector).toBeHidden();
  await expect(page).not.toHaveURL(/inspector=/);
  await page.goBack();
  await expect(inspector).toBeVisible();
  await expect(page).toHaveURL(/inspector=files/);
});

test("the Changes tab keeps the full git review with diffs and commit controls", async ({
  page,
}) => {
  await mockSessionHome(page);
  await page.goto(`/chat?project=all&chatThread=${HOME.chatA}&inspector=diff`);
  const inspector = page.getByTestId("session-inspector");
  await expect(inspector.getByTestId("terminal-git-panel")).toBeVisible();
  await expect(inspector.getByTestId("git-changes-summary")).toHaveText("1");
  await expect(inspector.getByTestId("git-commit-message")).toBeVisible();
  await expect(
    inspector.getByRole("button", { name: /src\/cart\/total\.ts Modified/ }),
  ).toBeVisible();
});
