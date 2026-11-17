import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { expect, test } from "@playwright/test";
import { chooseChatAgent } from "./_chat-ui";
import { gotoView, repoRoot } from "./_helpers";

const claudeCommands = {
  commands: [
    {
      name: "code-review",
      token: "/code-review",
      description:
        "Review the current diff, or a PR number/branch/path target, for correctness bugs",
      argumentHint: "[low|medium|high|xhigh|max] [--fix] [--comment] [<pr#>|<branch>|<path>]",
      aliases: ["review"],
      source: "claude",
    },
    {
      name: "feature-dev:feature-dev",
      token: "/feature-dev:feature-dev",
      description: "Guided feature development with codebase understanding and architecture focus",
      argumentHint: "Optional feature description",
      aliases: [],
      source: "feature-dev",
    },
  ],
  warning: null,
};

for (const width of [1440, 390]) {
  test(`composer lists agent commands and @ files at ${width}px`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const agents: string[] = [];
    await page.route("**/api/chat/commands?**", (route) => {
      const params = new URL(route.request().url()).searchParams;
      const agent = params.get("agent") ?? "";
      agents.push(`${agent}:${params.get("cwd")}`);
      return route.fulfill({
        json:
          agent === "claude"
            ? claudeCommands
            : { commands: [], warning: "Agent commands unavailable" },
      });
    });
    const root = repoRoot();
    await page.addInitScript(
      (tree) =>
        localStorage.setItem(
          "orc_folder_history",
          JSON.stringify({ local: { last: tree, recent: [tree] } }),
        ),
      root,
    );
    await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
    await gotoView(page, "activity");
    await page.goto("/?chat=open");
    await chooseChatAgent(page, "claude");
    const input = page.getByTestId("chat-input").filter({ visible: true });
    const menu = page.getByTestId("chat-prompt-menu");
    const options = menu.getByTestId("chat-prompt-option");

    await input.click();
    await input.pressSequentially("/revi");
    await expect(options.first()).toHaveAttribute("data-kind", "agent");
    await expect(options.first()).toContainText("/code-review");
    await expect(options.first()).toContainText("claude");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath(`agent-commands-${width}.png`) });
    await input.press("Enter");
    await expect(input).toHaveValue("/code-review ");
    await expect(menu).toHaveCount(0);

    await input.fill("");
    await input.pressSequentially("@packages/ap");
    await expect(options.first()).toContainText("api/");
    await expect(options.first()).toHaveAttribute("data-kind", "folder");
    await page.screenshot({ path: testInfo.outputPath(`file-mentions-${width}.png`) });
    await input.press("Tab");
    await expect(input).toHaveValue("@packages/api/");
    await expect(options.filter({ hasText: "package.json" })).toHaveCount(1);
    await input.pressSequentially("pkgjs");
    await expect(options.first()).toContainText("package.json");
    await options.first().click();
    await expect(input).toHaveValue("@packages/api/package.json ");
    await expect(menu).toHaveCount(0);

    const spaced = testInfo.outputPath("mention fixture");
    mkdirSync(spaced, { recursive: true });
    writeFileSync(join(spaced, "notes.md"), "");
    const parent = `${relative(root, dirname(spaced))}/`;
    await input.fill("");
    await input.pressSequentially(`@${parent}mention`);
    await expect(options.first()).toContainText("mention fixture/");
    await input.press("Enter");
    await expect(input).toHaveValue(`@"${parent}mention fixture/`);
    await expect(options.first()).toContainText("notes.md");
    await input.press("Enter");
    await expect(input).toHaveValue(`@"${parent}mention fixture/notes.md" `);

    await input.fill("");
    await input.pressSequentially("@missing-folder/");
    await expect(page.getByTestId("chat-prompt-status")).toHaveText("Folder not readable");
    await page.screenshot({ path: testInfo.outputPath(`file-mentions-error-${width}.png`) });
    await input.press("Escape");
    await expect(menu).toHaveCount(0);

    await page.route("**/api/chat/files?**", (route) =>
      route.fulfill({
        status: 502,
        json: {
          error: "box does not resolve. Check the HostName in ~/.ssh/config.",
          code: "SSH_FAILED",
        },
      }),
    );
    await input.fill("");
    await input.pressSequentially("@other/");
    await expect(page.getByTestId("chat-prompt-status")).toHaveText(
      "box does not resolve. Check the HostName in ~/.ssh/config.",
    );
    await page.unroute("**/api/chat/files?**");
    await input.press("Escape");

    await input.fill("");
    await input.pressSequentially("/zzqqxx");
    await expect(page.getByTestId("chat-prompt-status")).toHaveText("No matches");
    await page.screenshot({ path: testInfo.outputPath(`agent-commands-empty-${width}.png`) });
    await input.press("Escape");
    await expect(menu).toHaveCount(0);

    await chooseChatAgent(page, "codex");
    await input.click();
    await expect(input).toBeFocused();
    await input.fill("");
    await input.pressSequentially("/");
    await expect(page.getByTestId("chat-prompt-status")).toHaveText("Agent commands unavailable");
    expect(agents).toEqual([`claude:${root}`, `codex:${root}`]);
    expect(errors).toEqual([]);
  });
}
