import { expect, test } from "@playwright/test";
import { HOME, mockSessionHome } from "./_session-home-demo";

for (const width of [1440, 390]) {
  test.describe(`unified workspace at ${width}px`, () => {
    test.use({ viewport: { width, height: 844 } });

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
