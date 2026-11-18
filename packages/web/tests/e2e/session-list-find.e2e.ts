import { expect, type Locator, type Page, test } from "@playwright/test";
import { demoProjects, type LiveRow, liveRows, mockDemo } from "./_session-demo";

const ids = (rows: Locator, attribute: string) =>
  rows.evaluateAll((nodes, name) => nodes.map((node) => node.getAttribute(name)), attribute);

async function setup(page: Page, request: Parameters<typeof demoProjects>[0]) {
  // The chat page owns the session list; its session view is the Recents tab.
  await page.addInitScript(() => localStorage.setItem("orc_chat_history_section_v2", "recents"));
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

const sessionUrl = "/chat?project=all&sessionList=show";

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

    test("filters to Needs you with counts and remembers the chat filter", async ({
      page,
      request,
    }) => {
      await setup(page, request);
      await page.goto(sessionUrl);
      const rows = page.getByTestId("chat-session-list").getByTestId("chat-history-row");
      await expect(rows).toHaveCount(10);
      const needsYou = page.getByTestId("session-filter-needs-you");
      await expect(needsYou.getByTestId("session-filter-count")).toHaveText("3");
      await expect(
        page.getByTestId("session-filter-done").getByTestId("session-filter-count"),
      ).toHaveText("2");
      await needsYou.click();
      await expect(needsYou).toHaveAttribute("aria-pressed", "true");
      await expect(rows).toHaveCount(3);
      expect(await ids(rows, "data-state")).toEqual(["needs-you", "failed", "needs-you"]);

      await page.reload();
      await expect(page.getByTestId("session-filter-needs-you")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(rows).toHaveCount(3);
    });

    test("jumps to sessions that need you, then unseen Done, with one shortcut", async ({
      page,
      request,
    }) => {
      const { events } = await setup(page, request);
      await page.goto(sessionUrl);
      await expect(
        page.getByTestId("chat-session-list").getByTestId("chat-history-row"),
      ).toHaveCount(10);
      await page.keyboard.press("Control+k");
      await page.getByTestId("command-palette-input").fill("next session that needs you");
      const command = page.locator('[data-command-id="next-needs-you"]');
      await expect(command).toContainText("Alt J");
      await page.keyboard.press("Enter");
      await expect.poll(() => events.resumed).toEqual(["demo-live-0"]);
      const order = [0, 1, 4, 3, 6];
      for (const index of order.keys()) {
        if (!index) continue;
        await page.keyboard.press("Alt+KeyJ");
        await expect
          .poll(() => events.resumed.slice(0, index + 1))
          .toEqual(order.slice(0, index + 1).map((id) => `demo-live-${id}`));
        await expect(page).not.toHaveURL(/sessionLive=/);
      }
      await page.goto(sessionUrl);
      await page.getByTestId("chat-session-search").fill("x");
      await page.keyboard.press("Alt+KeyJ");
      await expect(page).not.toHaveURL(/sessionLive=demo-live/);
    });

    test("keeps a finished, unopened session Done across reloads until it is opened", async ({
      page,
      request,
    }) => {
      const { events } = await setup(page, request);
      await page.goto(sessionUrl);
      const row = page.locator(
        '[data-testid="chat-history-row"][data-history-id="native:demo-live-3"]',
      );
      await expect(row).toHaveAttribute("data-state", "done");
      await expect(
        page.locator('[data-testid="chat-history-row"][data-history-id="native:demo-live-7"]'),
      ).toHaveAttribute("data-state", "idle");
      await page.reload();
      await expect(row).toHaveAttribute("data-state", "done");
      await expect(row.getByTestId("chat-session-status")).toHaveAttribute("aria-label", /Done/);

      await row.getByTestId("chat-resume-live").click();
      await expect.poll(() => events.resumed).toEqual(["demo-live-3"]);
      await page.goto(sessionUrl);
      await expect(row).toHaveAttribute("data-state", "idle");
    });

    test("never moves a row under the pointer and applies the new order from the pill", async ({
      page,
      request,
    }) => {
      const { sessions, events } = await setup(page, request);
      await page.goto(sessionUrl);
      const rows = page.getByTestId("chat-session-list").getByTestId("chat-history-row");
      await expect(rows).toHaveCount(10);
      const before = await ids(rows, "data-history-id");
      const moving = rows.filter({ hasText: "Review API pagination" });
      const top = (await moving.boundingBox())?.y;
      await rows.first().hover();
      touch(sessions[6], "running");
      await events.push();
      await expect(moving).toHaveAttribute("data-state", "working");
      const pill = page.getByTestId("stable-order-pill");
      await expect(pill).toHaveText(/1 updated/);
      expect(await ids(rows, "data-history-id")).toEqual(before);
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
    });

    test("drops a row that leaves the Done filter while the pointer is on the list", async ({
      page,
      request,
    }) => {
      const { sessions, events } = await setup(page, request);
      await page.goto(sessionUrl);
      await page.getByTestId("session-filter-done").click();
      const rows = page.getByTestId("chat-session-list").getByTestId("chat-history-row");
      await expect(rows).toHaveCount(2);
      await rows.first().hover();
      touch(sessions[3], "running");
      await events.push();
      await expect(rows).toHaveCount(1);
      expect(await ids(rows, "data-state")).toEqual(["done"]);
    });

    for (const filter of ["all", "done"] as const)
      test(`keeps an opened Done row in place under the ${filter} filter`, async ({
        page,
        request,
      }) => {
        await setup(page, request);
        let release = () => {};
        const opened = new Promise<void>((resolve) => {
          release = resolve;
        });
        await page.route("**/api/chat/threads", async (route) => {
          if (route.request().method() === "POST") await opened;
          await route.fallback();
        });
        await page.goto(sessionUrl);
        if (filter === "done") await page.getByTestId("session-filter-done").click();
        const rows = page.getByTestId("chat-session-list").locator("[data-history-id]");
        const row = rows.filter({ hasText: "Write release notes" });
        await expect(row).toHaveAttribute("data-state", "done");
        const before = await ids(rows, "data-history-id");
        const index = before.indexOf("native:demo-live-3");
        const top = (await row.boundingBox())?.y;
        await row.hover();
        await row.getByTestId("chat-resume-live").click();
        await expect(rows.nth(index)).toHaveAttribute("data-history-id", "native:demo-live-3");
        expect((await row.boundingBox())?.y).toBe(top);
        release();
        await expect(page).toHaveURL(/chatThread=70000000-0000-4000-8000-000000000004/);
        if (width < 600) await page.goBack();
        await expect(rows.nth(index)).toHaveAttribute(
          "data-history-id",
          "chat:70000000-0000-4000-8000-000000000004",
        );
        expect(await ids(rows, "data-history-id")).toEqual(
          before.map((id) =>
            id === "native:demo-live-3" ? "chat:70000000-0000-4000-8000-000000000004" : id,
          ),
        );
        expect((await row.boundingBox())?.y).toBe(top);
      });

    test("keeps a Done row in place when it fails to open", async ({ page, request }) => {
      await setup(page, request);
      await page.route("**/api/chat/threads", (route) =>
        route.request().method() === "POST"
          ? route.fulfill({ status: 400, json: { error: "Session folder is unavailable." } })
          : route.fallback(),
      );
      await page.goto(sessionUrl);
      const rows = page.getByTestId("chat-session-list").locator("[data-history-id]");
      const row = rows.filter({ hasText: "Write release notes" });
      await expect(row).toHaveAttribute("data-state", "done");
      const before = await ids(rows, "data-history-id");
      await row.hover();
      await row.getByTestId("chat-resume-live").click();
      await expect(page.getByText("Session folder is unavailable.")).toBeVisible();
      await expect(row).toHaveAttribute("data-state", "idle");
      expect(await ids(rows, "data-history-id")).toEqual(before);
    });

    test("opens the project and marks the session the chat page is showing", async ({
      page,
      request,
    }) => {
      const { projects, sessions } = await setup(page, request);
      await page.addInitScript(() =>
        localStorage.setItem("orc_chat_history_section_v2", "projects"),
      );
      await page.goto("/chat?project=all&sessionLive=demo-live-7&sessionList=show");
      await expect(page).not.toHaveURL(/sessionLive=/);
      const group = page.getByTestId(`session-project-${projects[2]}`);
      await expect(group.getByTestId("session-project-toggle")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      await expect(group.locator('[data-active="true"]')).toContainText(sessions[7]?.name ?? "");
      const other = page
        .getByTestId(`session-project-${projects[0]}`)
        .getByTestId("session-project-toggle");
      await expect(other).toHaveAttribute("aria-expanded", "false");
      await other.click();
      await expect(other).toHaveAttribute("aria-expanded", "true");
      await expect(group.getByTestId("session-project-toggle")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
    });

    test("spins the working icon and settles it when the agent stops", async ({
      page,
      request,
    }) => {
      const { sessions, events } = await setup(page, request);
      await page.goto(sessionUrl);
      const working = page
        .getByTestId("chat-session-list")
        .locator('[data-history-id="native:demo-live-2"]');
      const status = working.getByTestId("chat-session-status");
      await expect(status).toHaveAttribute("data-state", "working");
      await expect(status.locator("svg")).toHaveClass(/animate-spin/);

      touch(sessions[2], "idle");
      await events.push();
      await expect(status).toHaveAttribute("data-state", "done");
      await expect(status.locator("svg")).not.toHaveClass(/animate-spin/);
    });

    test("shows how many sessions need you on each project", async ({ page, request }) => {
      const { projects } = await setup(page, request);
      await page.goto(sessionUrl);
      await expect(
        page.getByTestId("chat-session-list").getByTestId("chat-history-row"),
      ).toHaveCount(10);
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
