import { expect, type Locator, type Page, test } from "@playwright/test";
import { openChatHistory } from "./_chat-ui";
import { demoProjects, type LiveRow, liveRows, mockDemo } from "./_session-demo";

const ids = (rows: Locator, attribute: string) =>
  rows.evaluateAll((nodes, name) => nodes.map((node) => node.getAttribute(name)), attribute);

async function setup(page: Page, request: Parameters<typeof demoProjects>[0]) {
  const projects = await demoProjects(request);
  const sessions = liveRows(projects);
  const events = await mockDemo(page, sessions, {
    since: Date.now() - 30 * 60_000,
    seen: { "native:demo-live-7": Date.now() },
  });
  return { projects, sessions, events };
}

function touch(session: LiveRow, status: LiveRow["status"]) {
  session.status = status;
  session.last_activity_at = new Date().toISOString();
}

async function openProjectPicker(page: Page) {
  const mobile = page.getByTestId("mobile-nav-open");
  if (await mobile.isVisible()) await mobile.click();
  const drawer = page.getByTestId("mobile-nav-drawer");
  await ((await drawer.isVisible())
    ? drawer.getByTestId("sidebar-project-select")
    : page.getByTestId("sidebar-project-select")
  ).click();
}

for (const width of [1440, 390])
  test.describe(`session list find at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test("filters to Needs you with counts on both lists and remembers the chat filter", async ({
      page,
      request,
    }) => {
      await setup(page, request);
      await page.goto("/sessions?project=all");
      const rows = page.getByTestId("live-session-row");
      await expect(rows).toHaveCount(10);
      const needsYou = page.getByTestId("session-filter-needs-you");
      await expect(needsYou.getByTestId("session-filter-count")).toHaveText("3");
      await expect(
        page.getByTestId("session-filter-done").getByTestId("session-filter-count"),
      ).toHaveText("2");
      await needsYou.click();
      await expect(needsYou).toHaveAttribute("aria-pressed", "true");
      await expect(page).toHaveURL(/state=needs-you/);
      await expect(rows).toHaveCount(3);
      expect(await ids(rows, "data-state")).toEqual(["needs-you", "failed", "needs-you"]);

      await page.goto("/tasks?chat=full&project=all");
      await openChatHistory(page);
      const list = page.getByTestId("chat-session-list");
      await expect(list.getByTestId("chat-history-row")).toHaveCount(10);
      await page.getByTestId("session-filter-needs-you").click();
      await expect(list.getByTestId("chat-history-row")).toHaveCount(3);
      await page.reload();
      await openChatHistory(page);
      await expect(page.getByTestId("session-filter-needs-you")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(list.getByTestId("chat-history-row")).toHaveCount(3);
    });

    test("jumps to sessions that need you, then unseen Done, with one shortcut", async ({
      page,
      request,
    }) => {
      await setup(page, request);
      await page.goto("/sessions?project=all");
      await expect(page.getByTestId("live-session-row")).toHaveCount(10);
      const detail = page.getByTestId("live-session-detail");
      for (const expected of [0, 1, 4, 3, 6]) {
        await page.keyboard.press("Alt+KeyJ");
        await expect(page).toHaveURL(new RegExp(`session=demo-live-${expected}(&|$)`));
        await expect(detail).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(detail).toBeHidden();
      }
      await page.getByTestId("session-search").fill("x");
      await page.keyboard.press("Alt+KeyJ");
      await expect(page).not.toHaveURL(/session=demo-live/);

      await page.getByTestId("session-search").fill("");
      await page.keyboard.press("Control+k");
      await page.getByTestId("command-palette-input").fill("next session that needs you");
      const command = page.locator('[data-command-id="next-needs-you"]');
      await expect(command).toContainText("Alt J");
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/session=demo-live-0(&|$)/);
    });

    test("keeps a finished, unopened session Done across reloads until it is opened", async ({
      page,
      request,
    }) => {
      await setup(page, request);
      await page.goto("/sessions?project=all");
      const row = page.locator('[data-testid="live-session-row"][data-session-id^="00000003"]');
      await expect(row).toHaveAttribute("data-state", "done");
      await expect(
        page.locator('[data-testid="live-session-row"][data-session-id^="00000007"]'),
      ).toHaveAttribute("data-state", "idle");
      await page.reload();
      await expect(row).toHaveAttribute("data-state", "done");

      await page.goto("/tasks?chat=full&project=all");
      await openChatHistory(page);
      const chatRow = page.locator('[data-history-id="native:demo-live-3"]');
      await expect(chatRow).toHaveAttribute("data-state", "done");
      await expect(chatRow.getByTestId("chat-session-status")).toHaveAttribute(
        "aria-label",
        /Done/,
      );

      await page.goto("/sessions?project=all");
      await row.getByRole("button", { name: "Write release notes" }).click();
      await expect(page.getByTestId("live-session-detail")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(row).toHaveAttribute("data-state", "idle");
      await page.reload();
      await expect(row).toHaveAttribute("data-state", "idle");
      await page.goto("/tasks?chat=full&project=all");
      await openChatHistory(page);
      await expect(chatRow).toHaveAttribute("data-state", "idle");
    });

    test("never moves a row under the pointer and applies the new order from the pill", async ({
      page,
      request,
    }) => {
      const { sessions, events } = await setup(page, request);
      await page.goto("/sessions?project=all");
      const rows = page.getByTestId("live-session-row");
      await expect(rows).toHaveCount(10);
      const before = await ids(rows, "data-session-id");
      const moving = rows.filter({ hasText: "Review API pagination" });
      const top = (await moving.boundingBox())?.y;
      await rows.first().hover();
      touch(sessions[6], "running");
      await events.push();
      await expect(moving).toHaveAttribute("data-state", "working");
      const pill = page.getByTestId("stable-order-pill");
      await expect(pill).toHaveText(/1 updated/);
      expect(await ids(rows, "data-session-id")).toEqual(before);
      expect((await moving.boundingBox())?.y).toBe(top);
      await pill.click();
      await expect(pill).toBeHidden();
      await expect(rows.first()).toContainText("Review API pagination");

      touch(sessions[3], "running");
      await events.push();
      await expect(rows.filter({ hasText: "Write release notes" }).first()).toHaveAttribute(
        "data-state",
        "working",
      );
      await expect(pill).toBeVisible();
      await expect(rows.first()).toContainText("Review API pagination");
      await page.mouse.move(width - 2, 2);
      await expect(pill).toBeHidden();
      await expect(rows.first()).toContainText("Write release notes");

      await page.goto("/tasks?chat=full&project=all");
      await openChatHistory(page);
      const chatRows = page.getByTestId("chat-session-list").getByTestId("chat-history-row");
      await expect(chatRows).toHaveCount(10);
      const chatBefore = await ids(chatRows, "data-history-id");
      await chatRows.first().hover();
      touch(sessions[8], "running");
      await events.push();
      await expect(page.locator('[data-history-id="native:demo-live-8"]')).toHaveAttribute(
        "data-state",
        "working",
      );
      await expect(page.getByTestId("stable-order-pill")).toBeVisible();
      expect(await ids(chatRows, "data-history-id")).toEqual(chatBefore);
      await page.getByTestId("stable-order-pill").click();
      await expect(chatRows.first()).toHaveAttribute("data-history-id", "native:demo-live-8");
    });

    test("shows how many sessions need you on each project", async ({ page, request }) => {
      const { projects } = await setup(page, request);
      await page.goto("/sessions?project=all");
      await expect(page.getByTestId("live-session-row")).toHaveCount(10);
      await openProjectPicker(page);
      for (const [id, count] of [
        ["all", 3],
        [projects[0], 1],
        [projects[1], 1],
        [projects[2], 1],
      ] as const)
        await expect(
          page.getByTestId(`project-option-${id}`).getByTestId("project-needs-you"),
        ).toHaveAccessibleName(`${count} need you`);
      await expect(
        page.getByTestId("project-option-unassigned").getByTestId("project-needs-you"),
      ).toHaveCount(0);
    });
  });
