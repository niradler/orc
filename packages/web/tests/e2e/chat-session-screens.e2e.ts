import { ChatSettingsSchema, type ChatThread } from "@orc/core/chat";
import { expect, test } from "@playwright/test";
import { openChatSettings } from "./_chat-ui";
import { repoRoot } from "./_helpers";
import { HOME, mockSessionHome } from "./_session-home-demo";

// Docs screenshots for the chat session surfaces. Set ORC_CAPTURE_CHAT_SCREENS=1
// to refresh docs/public/screens; otherwise the shots stay in the test output.
const CAPTURE = process.env.ORC_CAPTURE_CHAT_SCREENS === "1";

for (const width of [1440, 390]) {
  test(`chat session UI screenshots at ${width}px`, async ({ page }, testInfo) => {
    const now = Date.now();
    const suffix = width === 1440 ? "desktop" : "phone";
    const shot = async (name: string) => {
      await page.screenshot({
        path: CAPTURE
          ? `${repoRoot()}/docs/public/screens/${name}-${suffix}.png`
          : testInfo.outputPath(`${name}-${suffix}.png`),
        animations: "disabled",
      });
    };
    const thread: ChatThread = {
      id: HOME.chatA,
      title: "Round cart totals to cents",
      config: ChatSettingsSchema.parse({
        agent: "claude",
        model: "claude-sonnet-4-5",
        permissionMode: "acceptEdits",
      }),
      cwd: "/home/demo/acme-shop",
      host: null,
      runtimeId: "6c1f0d8e-4a51-4a76-9b7f-2e1a3f5e9b21",
      sourceId: "live-demo-claude",
      backend: "claude-code",
      projectId: "proj-shop",
      capabilities: {
        version: 1,
        source: "adapter",
        resume: true,
        modelSelection: true,
        images: true,
        toolOutput: true,
        approvals: true,
        questions: true,
        livePermissions: true,
        interrupt: true,
        steering: true,
        mcp: true,
        fork: true,
        rollback: true,
      },
      updatedAt: now - 12 * 60_000,
      messages: [
        {
          id: `${HOME.chatA}-q1`,
          role: "user",
          content: "Cart totals show fractions of a cent. Please round them to cents.",
          timestamp: now - 32 * 60_000,
        },
        {
          id: `${HOME.chatA}-a1`,
          role: "assistant",
          content:
            "I found the rounding in `src/cart/total.ts`. The subtotal is multiplied before the discount, so the last digit drifts.\n\nI will round once at the money boundary and add a regression test.",
          timestamp: now - 28 * 60_000,
          turn: {
            startedAt: now - 30 * 60_000,
            finishedAt: now - 28 * 60_000,
            durationMs: 118_000,
            outcome: "completed",
          },
          activity: [
            { type: "tool", id: "t1", name: "Read", input: "src/cart/total.ts" },
            {
              type: "tool",
              id: "t2",
              name: "Edit",
              input: "src/cart/total.ts",
              result: "Updated 2 lines",
            },
          ],
        },
        {
          id: `${HOME.chatA}-q2`,
          role: "user",
          content: "Run the cart tests before you finish.",
          timestamp: now - 18 * 60_000,
        },
        {
          id: `${HOME.chatA}-a2`,
          role: "assistant",
          content:
            "The cart suite passes with the rounding change. Two snapshots needed updating for the new cent formatting.",
          timestamp: now - 12 * 60_000,
          turn: {
            startedAt: now - 16 * 60_000,
            finishedAt: now - 12 * 60_000,
            durationMs: 224_000,
            outcome: "completed",
          },
          activity: [
            { type: "tool", id: "t3", name: "Bash", input: "bun test src/cart" },
            {
              type: "tool",
              id: "t4",
              name: "Bash",
              input: "bun test src/cart --update-snapshots",
              result: "2 snapshots updated",
            },
            {
              type: "tool",
              id: "t5",
              name: "Bash",
              input: "bun test src/cart",
              isError: true,
              result: "One formatting assertion still fails",
            },
          ],
        },
      ],
    };
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(() => localStorage.setItem("orc_theme", "dark"));
    await mockSessionHome(page, now);
    await page.route(`**/api/chat/threads/${HOME.chatA}`, (route) =>
      route.fulfill({ json: thread }),
    );
    await page.route("**/api/git/worktrees?**", (route) =>
      route.fulfill({
        json: {
          root: "/home/demo/acme-shop",
          worktrees: [
            {
              path: "/home/demo/acme-shop",
              branch: "fix/cart-rounding",
              head: null,
              main: true,
              dirty: true,
              detached: false,
              locked: false,
              prunable: false,
            },
          ],
        },
      }),
    );
    await page.route("**/api/git/branches?**", (route) =>
      route.fulfill({
        json: {
          root: "/home/demo/acme-shop",
          current: "fix/cart-rounding",
          default_branch: "main",
          local: ["main", "fix/cart-rounding"],
          remote: ["origin/main"],
        },
      }),
    );
    await page.route("**/api/sessions/live/live-demo-claude/cache", (route) =>
      route.fulfill({
        json: {
          latest: {
            input_tokens: 48_210,
            cached_input_tokens: 41_120,
            cache_write_tokens: 2_048,
            recorded_at: new Date(now - 12 * 60_000).toISOString(),
            may_be_cold_after: null,
          },
          totals: {
            input_tokens: 168_400,
            cached_input_tokens: 142_300,
            cache_write_tokens: 5_120,
          },
          output_tokens: 18_760,
          requests: 12,
          compactions: [],
          timeline: null,
        },
      }),
    );
    await page.route(`**/api/chat/threads/${HOME.chatA}/analytics`, (route) =>
      route.fulfill({
        json: {
          messages: 4,
          userMessages: 2,
          assistantMessages: 2,
          turns: 2,
          toolCalls: 5,
          toolFailures: 1,
          attachments: 0,
          startedAt: now - 32 * 60_000,
          lastActivityAt: now - 12 * 60_000,
          outcomes: { completed: 2, stopped: 0, failed: 0, running: 0 },
          durations: {
            averageMs: 171_000,
            medianMs: 224_000,
            p95Ms: 224_000,
            totalMs: 342_000,
          },
          tools: [
            { name: "Bash", calls: 3, failures: 1 },
            { name: "Read", calls: 1, failures: 0 },
            { name: "Edit", calls: 1, failures: 0 },
          ],
          turnTimeline: [
            {
              index: 1,
              startedAt: now - 30 * 60_000,
              durationMs: 118_000,
              outcome: "completed",
              toolCalls: 2,
              toolFailures: 0,
              responseChars: 220,
            },
            {
              index: 2,
              startedAt: now - 16 * 60_000,
              durationMs: 224_000,
              outcome: "completed",
              toolCalls: 3,
              toolFailures: 1,
              responseChars: 118,
            },
          ],
          turnTimelineTruncated: false,
          context: {
            backend: "claude",
            model: "claude-sonnet-4-5",
            supported: true,
            reason: null,
            usage: {
              latest: {
                input_tokens: 48_210,
                cached_input_tokens: 41_120,
                cache_write_tokens: 2_048,
                recorded_at: new Date(now - 12 * 60_000).toISOString(),
                may_be_cold_after: null,
              },
              totals: {
                input_tokens: 168_400,
                cached_input_tokens: 142_300,
                cache_write_tokens: 5_120,
              },
              output_tokens: 18_760,
              requests: 12,
              compactions: [
                {
                  recorded_at: new Date(now - 20 * 60_000).toISOString(),
                  pre_tokens: 122_000,
                  post_tokens: 48_000,
                },
              ],
              timeline: [
                16_000, 21_000, 26_000, 32_000, 39_000, 46_000, 122_000, 48_000, 48_100, 48_150,
                48_200, 48_210,
              ].map((context, index) => ({
                request: index + 1,
                recorded_at: new Date(now - (32 - index * 2) * 60_000).toISOString(),
                context_tokens: context,
                cached_input_tokens: Math.round(context * 0.85),
                output_tokens: 900 + index * 100,
              })),
            },
          },
        },
      }),
    );
    const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
    const project = (id: string, name: string, scope: string) => ({
      id,
      name,
      description: null,
      status: "active",
      scope,
      git_remote_url: null,
      github_sync: null,
      github_sync_state: null,
      tags: null,
      obsidian_path: null,
      max_workers: null,
      upload_directory: null,
      workspace: {
        setup_script: null,
        dev_script: null,
        setup_timeout_secs: 0,
        port_base: null,
        port_count: 0,
        env: [],
      },
      created_at: iso(240),
      updated_at: iso(240),
    });
    await page.route(/\/api\/projects(\?.*)?$/, (route) =>
      route.fulfill({
        json: {
          projects: [
            project("proj-shop", "Acme Shop", "/home/demo/acme-shop"),
            project("proj-billing", "Billing API", "/home/demo/billing-api"),
          ],
          offset: 0,
          limit: 50,
          next_offset: null,
        },
      }),
    );
    const liveSession = (
      id: string,
      sessionId: string,
      name: string,
      agent: string,
      cwd: string,
      projectId: string,
      status: string,
      minutesAgo: number,
    ) => ({
      id,
      session_id: sessionId,
      name,
      agent,
      status,
      waiting_for_human: false,
      cwd,
      host: null,
      project_id: projectId,
      task_id: null,
      task: null,
      handoff: null,
      summary: null,
      tokens_used: 21_000,
      tokens_estimated: false,
      created_at: iso(minutesAgo + 20),
      last_activity_at: iso(minutesAgo),
    });
    await page.route("**/api/sessions/live?**", (route) =>
      route.fulfill({
        json: {
          sessions: [
            liveSession(
              HOME.claudeLive,
              "60000000-0000-4000-8000-000000000001",
              "Fix the cart total rounding",
              "claude",
              "/home/demo/acme-shop",
              "proj-shop",
              "running",
              1,
            ),
            liveSession(
              HOME.codexLive,
              "60000000-0000-4000-8000-000000000002",
              "Upgrade the payments SDK",
              "codex",
              "/home/demo/billing-api",
              "proj-billing",
              "running",
              6,
            ),
          ],
          total: 2,
          has_more: false,
        },
      }),
    );

    await page.goto(`/chat?project=all&chatThread=${HOME.chatA}`);
    await expect(page.getByTestId("chat-message-content").last()).toContainText("snapshots");
    await expect(page.getByTestId("chat-workspace-folder")).toBeVisible();
    await expect(page.getByTestId("chat-workspace-branch")).toBeVisible();
    await expect(page.getByTestId("chat-permission-chip")).toBeVisible();
    await shot("chat-session-composer");

    await openChatSettings(page);
    await expect(page.getByTestId("chat-session-id-agent")).toContainText("6c1f0d8e");
    if (width === 1440) await shot("chat-session-settings-overview");
    await page.getByTestId("chat-settings-tab-customize").click();
    if (width === 390) await shot("chat-session-settings-customize");
    await page.getByTestId("chat-settings-tab-analytics").click();
    await expect(page.getByTestId("chat-analytics-turns")).toContainText("2");
    await expect(page.getByTestId("chat-context-chart")).toBeVisible();
    await expect(page.getByTestId("chat-tool-chart")).toBeVisible();
    await expect(page.getByTestId("chat-turn-chart")).toBeVisible();
    if (width === 1440) await shot("chat-session-settings-analytics");
    else
      await page.screenshot({
        path: testInfo.outputPath("chat-session-settings-analytics-phone.png"),
      });
    await page
      .getByTestId("chat-analytics-tools-heading")
      .evaluate((element) => element.scrollIntoView({ block: "start" }));
    if (width === 1440) await shot("chat-session-settings-analytics-tools");
    await page
      .getByTestId("chat-turn-chart")
      .evaluate((element) => element.scrollIntoView({ block: "center" }));
    if (width === 390)
      await page.screenshot({
        path: testInfo.outputPath("chat-session-settings-analytics-turns-phone.png"),
      });
    await page.keyboard.press("Escape");
  });
}
