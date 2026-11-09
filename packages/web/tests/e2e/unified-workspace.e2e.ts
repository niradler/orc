import { expect, test } from "@playwright/test";
import { HOME, mockSessionHome } from "./_session-home-demo";

for (const width of [1440, 390]) {
  test.describe(`unified workspace at ${width}px`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: width === 390 });

    test("should keep provider changes and model discovery scoped to their own pane and host", async ({
      page,
    }) => {
      await mockSessionHome(page);
      await page.route("**/api/settings/providers", (route) =>
        route.fulfill({
          json: {
            revision: "0".repeat(64),
            default_provider_id: "claude",
            providers: [
              {
                id: "claude",
                name: "Claude Code",
                agent: "claude",
                enabled: true,
                model: "",
                executable: "",
                environment: [],
              },
              {
                id: "review",
                name: "Review",
                agent: "claude",
                enabled: true,
                model: "review-model",
                executable: "",
                environment: [],
              },
            ],
          },
        }),
      );
      await page.route("**/api/ssh", (route) =>
        route.fulfill({ json: { host: null, hosts: ["lab"], supported: true } }),
      );
      await page.route("**/api/terminals/browse?**", (route) =>
        route.fulfill({
          json: {
            host: "lab",
            path: "/remote",
            parent: "/",
            directories: [],
          },
        }),
      );
      await page.route("**/api/git/worktrees?**", (route) =>
        route.fulfill({
          json: {
            root: "/remote/review",
            worktrees: [],
          },
        }),
      );
      const discoveries: URLSearchParams[] = [];
      await page.route("**/api/chat/models?**", (route) => {
        discoveries.push(new URL(route.request().url()).searchParams);
        return route.fulfill({
          json: { models: [{ id: "review-model", label: "Review model" }], warning: null },
        });
      });
      await page.goto("/workspace?project=all&chat=full");
      const primary = page.getByTestId("session-primary-pane");
      await expect(primary.getByTestId("chat-agent-model-button")).toBeEnabled();
      const original = await primary.getByTestId("chat-agent-current").textContent();
      await page.getByTestId("workspace-parallel").click();
      if (width < 1024) await page.getByTestId("parallel-tab-1").click();
      const secondary = page.getByTestId("session-secondary-pane");
      await secondary.getByTestId("chat-agent-model-button").click();
      await page.getByTestId("chat-provider-option-review").click();
      await page.keyboard.press("Escape");
      await expect(secondary.getByTestId("chat-agent-current")).toHaveText("Review");
      await expect(primary.getByTestId("chat-agent-current")).toHaveText(original ?? "");
      await secondary.getByTestId("chat-workspace-folder").click();
      await page.getByTestId("chat-workspace-host-option").filter({ hasText: "lab" }).click();
      await page.getByTestId("chat-workspace-cwd").fill("/remote/review");
      await page.getByTestId("chat-workspace-apply").click();
      await expect
        .poll(() =>
          discoveries.some(
            (query) =>
              query.get("host") === "lab" &&
              query.get("cwd") === "/remote/review" &&
              query.get("providerId") === "review",
          ),
        )
        .toBe(true);
      await expect(primary.getByTestId("chat-agent-current")).toHaveText(original ?? "");
    });

    test("should keep an externally owned conversation readable when chat resume is blocked", async ({
      page,
    }) => {
      await mockSessionHome(page);
      await page.route("**/api/chat/threads", (route) =>
        route.request().method() === "POST"
          ? route.fulfill({
              status: 409,
              json: { error: "End the original agent session before resuming it in chat." },
            })
          : route.fallback(),
      );
      await page.route(`**/api/sessions/live/${HOME.codexLive}/transcript?**`, (route) =>
        route.fulfill({
          json: {
            total: 1,
            offset: 0,
            matches: [],
            turns: [
              {
                index: 0,
                role: "assistant",
                time: null,
                blocks: [{ type: "text", text: "Existing session remains readable." }],
              },
            ],
          },
        }),
      );
      await page.goto("/workspace?project=all&chat=full");
      if (width < 1024) await page.getByTestId("chat-sessions-button").click();
      await page
        .locator(`[data-history-id="native:${HOME.codexLive}"]`)
        .filter({ visible: true })
        .getByTestId("chat-resume-live")
        .click();
      await expect(page.getByTestId("session-read-only-notice")).toContainText(
        "End the original agent session",
      );
      await expect(page.getByTestId("live-session-detail")).toContainText(
        "Existing session remains readable.",
      );
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("live-session-detail")).toHaveCount(0);
      await expect(page.getByTestId("chat-input").filter({ visible: true })).toBeVisible();
    });

    test("should keep split controls contextual to the terminal", async ({ page }, testInfo) => {
      await mockSessionHome(page);
      let played = false;
      await page.route(`**/api/terminals/${HOME.terminal}/ticket`, (route) =>
        route.fulfill({
          json: {
            ticket: "local-demo-fixture",
            expires_in: 60,
          },
        }),
      );
      await page.routeWebSocket(`**/terminals/${HOME.terminal}/ws**`, (socket) => {
        played = true;
        socket.send(
          Buffer.from(
            "\u001b[2J\u001b[HORC session workspace\r\n\r\ndemo@workspace $ bun test\r\n\u001b[32m24 checks passed\u001b[0m\r\n\r\nRuntime retained after reload.\r\nFolder: /home/demo/acme-shop\r\n\r\ndemo@workspace $ ",
          ),
        );
        socket.send(JSON.stringify({ type: "replay-end" }));
      });
      await page.route(/\/api\/projects(\?.*)?$/, (route) =>
        route.fulfill({
          json: {
            projects: [
              { id: "shop", name: "Acme shop", scope: "/home/demo/acme-shop", status: "active" },
            ],
            total: 1,
          },
        }),
      );
      await page.goto(
        `/workspace?project=all&chat=full&sessionTerminal=${HOME.terminal}&drawer=terminal`,
      );
      await expect(page.getByTestId("session-terminal")).toBeVisible();
      await expect(page.getByTestId("session-drawer-toggle")).toHaveCount(0);
      await expect(page.getByTestId("session-inspector-toggle")).toHaveCount(0);
      await expect(page.getByTestId("session-drawer")).toHaveCount(0);
      await expect(page.getByTestId("pane-split-horizontal")).toHaveCount(1);
      await expect(page.getByTestId("pane-split-vertical")).toHaveCount(1);
      await expect(page.getByTestId("terminal-continue-chat")).toHaveCount(1);
      await expect(page.getByTestId("chat-send-button")).toHaveCount(0);
      await expect(page.getByTestId("composer-settings")).toBeVisible();
      await expect(page.getByTestId("chat-attach-button")).toBeVisible();
      await expect(
        page.getByTestId("session-project-breadcrumb").filter({ visible: true }),
      ).toHaveText("Acme shop");
      await expect.poll(() => played).toBe(true);
      await expect(page.getByTestId("terminal-surface").locator("canvas").first()).toBeVisible();
      if (width === 390)
        await expect(page.getByTestId("terminal-text-layer")).toContainText(
          "Runtime retained after reload.",
        );
      await page.screenshot({
        path: testInfo.outputPath(`workspace-terminal-${width}.png`),
        animations: "disabled",
      });
    });

    test("should find older folder-matched sessions inside their project", async ({
      page,
    }, testInfo) => {
      const fixture = await mockSessionHome(page);
      const sessions = Array.from({ length: 110 }, (_, index) => ({
        ...fixture.live[1],
        id: `folder-session-${index}`,
        session_id: `folder-runtime-${index}`,
        name: `Folder session ${index}`,
        status: "stopped",
        waiting_for_human: false,
        project_id: null,
        cwd: index < 55 ? "C:/Projects/other" : "\\\\?\\C:\\Projects\\ORC\\packages\\web",
        last_activity_at: new Date(Date.now() - index * 60_000).toISOString(),
      }));
      await page.route("**/api/projects?**", (route) =>
        route.fulfill({
          json: {
            projects: [{ id: "orc", name: "orc", status: "active", scope: "C:/Projects/orc" }],
            next_offset: null,
          },
        }),
      );
      await page.route("**/api/sessions/live?**", (route) =>
        route.fulfill({ json: { sessions, total: sessions.length, has_more: false } }),
      );
      await page.goto("/workspace?project=all&chat=full");
      if (width < 1024) await page.getByTestId("chat-sessions-button").click();
      await page.getByTestId("session-navigation-projects").click();
      const projects = page.getByRole("region", { name: "Projects", exact: true });
      await projects.getByRole("button", { name: /^orc/ }).click();
      await expect(projects.locator("[data-history-id]")).toHaveCount(50);
      await expect(projects.locator('[data-history-id="native:folder-session-55"]')).toBeVisible();
      await page.getByTestId("chat-history-more").click();
      await expect(projects.locator("[data-history-id]")).toHaveCount(55);
      await expect(
        projects.locator('[data-history-id="native:folder-session-109"]'),
      ).toBeAttached();
      await expect(page.getByTestId("chat-history-more")).toHaveCount(0);
      if (width < 1024)
        await expect(
          page
            .getByTestId("chat-sessions-dialog")
            .getByRole("heading", { name: "Sessions", exact: true }),
        ).toBeVisible();
      await page.getByTestId("session-navigation-projects").scrollIntoViewIfNeeded();
      await page.screenshot({
        path: testInfo.outputPath(`workspace-projects-${width}.png`),
        animations: "disabled",
      });
    });

    test("should disclose settings help on focus, hover and tap without consuming the form", async ({
      page,
    }, testInfo) => {
      const fixture = await mockSessionHome(page);
      fixture.chats[0].projectId = "demo-project";
      fixture.chats[0].runtimeId = fixture.live[0].session_id;
      await page.route(/\/api\/projects(\?.*)?$/, (route) =>
        route.fulfill({
          json: {
            projects: [
              {
                id: "demo-project",
                name: "Acme shop",
                scope: "/home/demo/acme-shop",
                status: "active",
              },
            ],
            total: 1,
          },
        }),
      );
      await page.goto(`/workspace?project=all&chat=full&chatThread=${HOME.chatA}`);
      await page.getByTestId("composer-settings").click();
      const help = page.getByTestId("chat-permission-help");
      const content = page.getByTestId("chat-permission-help-content");
      await expect(content).toHaveCount(0);
      await help.focus();
      await expect(content).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(content).toHaveCount(0);
      await page.getByTestId("chat-permission-mode").focus();
      await help.hover();
      await expect(content).toBeVisible();
      await page.getByTestId("workspace-parallel").hover();
      await expect(content).toHaveCount(0);
      await help.click();
      await expect(content).toBeVisible();
      await page.getByTestId("chat-permission-mode").click();
      await expect(content).toHaveCount(0);
      await page.keyboard.press("Escape");
      await page.getByTestId("chat-input").click();
      await page.screenshot({
        path: testInfo.outputPath(`workspace-settings-${width}.png`),
        animations: "disabled",
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    });

    test("should open full-page chat by default and preserve independent parallel drafts", async ({
      page,
    }) => {
      await mockSessionHome(page);
      await page.goto("/");
      await expect(page.getByTestId("unified-session-workspace")).toBeVisible();
      await expect(page).toHaveURL(/\/workspace\?.*chat=full/);
      const primary = page.getByTestId("session-primary-pane");
      await primary.getByTestId("chat-input").fill("Primary draft");
      await page.getByTestId("workspace-parallel").click();
      if (width < 1024) await page.getByTestId("parallel-tab-1").click();
      const secondary = page.getByTestId("session-secondary-pane");
      await secondary.getByTestId("chat-input").fill("Secondary draft");
      await secondary.getByTestId("chat-file-input").setInputFiles({
        name: "review.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Review attachment"),
      });
      await secondary.getByTestId("composer-settings").click();
      await expect(secondary.getByTestId("chat-settings-panel")).toBeVisible();
      await secondary.getByTestId("composer-settings").click();
      await expect(secondary.getByTestId("chat-attachments")).toContainText("review.txt");
      await expect(primary.getByTestId("chat-attachments")).toHaveCount(0);
      await secondary.getByTestId("chat-remove-attachment").click();
      await page.reload();
      if (width < 1024) await expect(secondary).toBeVisible();
      await expect(primary.getByTestId("chat-input")).toHaveValue("Primary draft");
      await expect(secondary.getByTestId("chat-input")).toHaveValue("Secondary draft");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    });

    test("should retain a closed conversation's draft after reload and reopening", async ({
      page,
    }) => {
      await mockSessionHome(page);
      await page.goto(`/workspace?project=all&chat=full&chatThread=${HOME.chatA}`);
      await expect(page.getByText("Here is the checkout plan.").first()).toBeVisible();
      await page
        .getByTestId("chat-input")
        .filter({ visible: true })
        .fill("Closed conversation draft");
      if (width < 1024) await page.getByTestId("chat-sessions-button").click();
      const row = page.locator(`[data-history-id="chat:${HOME.chatA}"]`).filter({ visible: true });
      await row.getByTestId("chat-tab-close").click();
      await expect(row).toHaveAttribute("data-history-open", "false");
      await page.reload();
      if (width < 1024) await expect(page.getByTestId("chat-sessions-dialog")).toBeVisible();
      await expect(row).toHaveAttribute("data-history-open", "false");
      await row.getByTestId("chat-session-select").click();
      await expect(page.getByTestId("chat-input").filter({ visible: true })).toHaveValue(
        "Closed conversation draft",
      );
    });

    test("should show reported native tokens in settings and fit Git to the inspector", async ({
      page,
    }) => {
      const fixture = await mockSessionHome(page);
      const chat = { ...fixture.chats[0], runtimeId: fixture.live[0].session_id };
      await page.route(`**/api/chat/threads/${HOME.chatA}`, (route) =>
        route.fulfill({ json: chat }),
      );
      await page.goto(`/workspace?project=all&chat=full&chatThread=${HOME.chatA}&inspector=diff`);
      const git = page.getByTestId("session-inspector").getByTestId("terminal-git-panel");
      await expect(git.getByTestId("git-files-menu")).toBeVisible();
      await expect(git.getByTestId("git-changed-files")).not.toBeVisible();
      await expect(git.getByTestId("git-diff-add").first()).toBeVisible();
      const bounds = await git.evaluate((element) => ({
        width: element.clientWidth,
        scroll: element.scrollWidth,
      }));
      expect(bounds.scroll).toBeLessThanOrEqual(bounds.width);
      if (width < 1024) await page.keyboard.press("Escape");
      else await page.getByRole("button", { name: "Close inspector", exact: true }).click();
      await page.getByTestId("composer-settings").filter({ visible: true }).click();
      await expect(
        page.getByTestId("chat-settings-panel").getByTestId("chat-token-count"),
      ).toHaveText("21,000");
    });

    test("should duplicate a terminal in its original host and folder while preserving the chat draft", async ({
      page,
    }) => {
      const fixture = await mockSessionHome(page);
      const terminals: Array<
        Omit<typeof fixture.terminal, "live_session_id"> & { live_session_id: string | null }
      > = [fixture.terminal];
      let requested: unknown;
      await page.route(/\/api\/terminals(\?.*)?$/, async (route) => {
        if (route.request().method() === "POST") {
          requested = route.request().postDataJSON();
          const duplicate = {
            ...fixture.terminal,
            id: "home-terminal-copy",
            name: `${fixture.terminal.name} (copy)`,
            live_session_id: null,
          };
          terminals.push(duplicate);
          await route.fulfill({ json: duplicate });
        } else
          await route.fulfill({
            json: {
              enabled: true,
              ready: true,
              reason: null,
              launchers: ["shell", "claude", "codex"],
              host: null,
              terminals,
            },
          });
      });
      await page.goto(`/workspace?project=all&chat=full&chatThread=${HOME.chatA}`);
      await page
        .getByTestId("chat-input")
        .filter({ visible: true })
        .fill("Draft before terminal duplication");
      await page.goto(
        `/workspace?project=all&chat=full&chatThread=${HOME.chatA}&sessionTerminal=${HOME.terminal}`,
      );
      await page.getByTestId("pane-actions").filter({ visible: true }).click();
      await page.getByTestId("terminal-actions").filter({ visible: true }).click();
      await page.getByTestId("terminal-duplicate").click();
      await expect(page).toHaveURL(/sessionTerminal=home-terminal-copy/);
      expect(requested).toMatchObject({
        kind: "claude",
        host: null,
        cwd: fixture.terminal.cwd,
        name: `${fixture.terminal.name} (copy)`,
      });
      await page.getByTestId("workspace-parallel").click();
      if (width < 1024) await page.getByTestId("parallel-tab-1").click();
      await expect(
        page.getByTestId("session-secondary-pane").getByTestId("chat-input"),
      ).toHaveValue("Draft before terminal duplication");
    });

    test("should focus an existing terminal across parallel workspaces instead of mounting it twice", async ({
      page,
    }) => {
      const fixture = await mockSessionHome(page);
      const shell = {
        ...fixture.terminal,
        id: "parallel-shell",
        kind: "shell",
        name: "Parallel shell",
        live_session_id: null,
      };
      await page.route(/\/api\/terminals(\?.*)?$/, (route) =>
        route.fulfill({
          json: {
            enabled: true,
            ready: true,
            reason: null,
            launchers: ["shell", "claude"],
            host: null,
            terminals: [fixture.terminal, shell],
          },
        }),
      );
      await page.goto(
        `/workspace?project=all&chat=full&sessionTerminal=${HOME.terminal}&parallel=1&parallelsessionTerminal=${shell.id}&parallelview=terminal&parallelpaneTerminal=${shell.id}`,
      );
      const primary = page.getByTestId("session-primary-pane");
      const secondary = page.getByTestId("session-secondary-pane");
      await expect(primary.getByTestId("terminal-viewport")).toHaveAttribute(
        "data-terminal-id",
        HOME.terminal,
      );
      if (width < 1024) await page.getByTestId("parallel-tab-1").click();
      await secondary.getByTestId("pane-terminal").click();
      await page.getByRole("option").filter({ hasText: fixture.terminal.name }).click();
      await expect(primary).toBeVisible();
      await expect(primary.getByTestId("terminal-viewport")).toHaveAttribute(
        "data-terminal-id",
        HOME.terminal,
      );
      await expect(secondary.getByTestId("terminal-viewport")).toHaveAttribute(
        "data-terminal-id",
        shell.id,
      );
      if (width < 1024) await expect(page.getByTestId("parallel-tab-1")).toHaveText(shell.name);
      const ids = await page
        .getByTestId("terminal-viewport")
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-terminal-id")));
      expect(new Set(ids).size).toBe(ids.length);
    });

    test("should keep a terminal canvas owned when a duplicated saved URL closes", async ({
      page,
    }) => {
      await mockSessionHome(page);
      await page.goto(
        `/workspace?project=all&chat=full&sessionTerminal=${HOME.terminal}&parallel=1&parallelsessionTerminal=${HOME.terminal}`,
      );
      const primary = page.getByTestId("session-primary-pane");
      const secondary = page.getByTestId("session-secondary-pane");
      await expect(primary.locator("canvas")).toHaveCount(1);
      await expect(secondary.getByTestId("terminal-already-open")).toHaveCount(1);
      await expect(secondary.locator("canvas")).toHaveCount(0);
      await page.getByTestId("workspace-parallel").click();
      await expect(primary.locator("canvas")).toHaveCount(1);
      await expect(primary.getByTestId("terminal-already-open")).toHaveCount(0);
    });

    test("should restore saved parallel sessions under delayed reads and expand the selected session", async ({
      page,
    }) => {
      await mockSessionHome(page);
      await page.goto(
        `/workspace?project=all&chat=full&chatThread=${HOME.chatA}&parallel=1&parallelchatThread=${HOME.chatB}`,
      );
      const primary = page.getByTestId("session-primary-pane");
      const secondary = page.getByTestId("session-secondary-pane");
      await primary.getByTestId("chat-input").fill("Saved first draft");
      if (width < 1024) await page.getByTestId("parallel-tab-1").click();
      await secondary.getByTestId("chat-input").fill("Saved second draft");
      let reads = 0;
      await page.route(`**/api/chat/threads/${HOME.chatA}`, async (route) => {
        if (++reads === 1) await new Promise((resolve) => setTimeout(resolve, 200));
        await route.fallback();
      });
      await page.reload();
      if (width < 1024) await page.getByTestId("parallel-tab-1").click();
      await expect(primary.getByTestId("chat-input")).toHaveValue("Saved first draft");
      await expect(secondary.getByTestId("chat-input")).toHaveValue("Saved second draft");
      if (width < 1024)
        await page.getByRole("button", { name: "Expand selected session", exact: true }).click();
      else await secondary.getByTestId("chat-fullscreen-button").click();
      await expect(page).not.toHaveURL(/parallel=1/);
      await expect(primary.getByTestId("chat-input")).toHaveValue("Saved second draft");
      await expect(page).toHaveURL(new RegExp(`chatThread=${HOME.chatB}`));
    });
  });
}
