import { spawnSync } from "node:child_process";
import { ChatSettingsSchema } from "@orc/core/chat";
import {
  type SessionDelivery,
  SessionMessageSchema,
  sessionMessageContext,
} from "@orc/core/session-messages";
import { expect, type Page, test } from "@playwright/test";
import { API_SECRET, repoRoot } from "./_helpers";

const headers = { Authorization: `Bearer ${API_SECRET}` };
const defaults = ChatSettingsSchema.parse({});

test.beforeEach(async ({ page, request }) => {
  await page.route("**/api/chat/models?**", (route) =>
    route.fulfill({ json: { models: [], warning: null } }),
  );
  await request.patch("/api/settings", { headers, data: { chat: defaults } });
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
});

function seedThread(thread: unknown): void {
  const seeded = spawnSync(
    "bun",
    [
      "-e",
      'import {getSqlite} from "./packages/db/src/client.ts";import {ChatStore} from "./packages/db/src/chat.ts";new ChatStore(getSqlite()).save(JSON.parse(process.argv[1]));',
      JSON.stringify(thread),
    ],
    { cwd: repoRoot(), env: process.env, encoding: "utf8", timeout: 10000 },
  );
  expect(seeded.status, seeded.stderr).toBe(0);
}

function makeThread(id: string, title: string, messages: unknown[], updatedAt = Date.now()) {
  return {
    id,
    title,
    config: defaults,
    cwd: "/tmp",
    host: null,
    runtimeId: null,
    backend: "codex-cli",
    sourceId: null,
    updatedAt,
    messages,
  };
}

async function openChatThread(page: Page, threadId: string, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await page.goto(`/chat?chatThread=${encodeURIComponent(threadId)}&project=all`);
  await expect(page.getByTestId("chat-panel")).toBeVisible();
  await expect(page.getByTestId("chat-messages")).toBeVisible();
}

test("renders child-outcome and relay deliveries as collapsed cards, expands body, and opens child session", async ({
  page,
}) => {
  const now = Date.now();
  const childId = crypto.randomUUID();
  const failedChildId = crypto.randomUUID();
  const waitingChildId = crypto.randomUUID();
  const stoppedChildId = crypto.randomUUID();
  const parentId = crypto.randomUUID();

  seedThread(
    makeThread(
      childId,
      "Fix auth retry race",
      [
        {
          id: `${childId}-u1`,
          role: "user",
          content: "Fix the auth retry race in session-auth.ts",
          timestamp: now - 120_000,
        },
        {
          id: `${childId}-a1`,
          role: "assistant",
          content: "Resolved the token refresh lock race and verified all 18 tests pass.",
          timestamp: now - 110_000,
        },
      ],
      now - 110_000,
    ),
  );

  const legacyNotice = SessionMessageSchema.parse({
    id: "01J00000000000000000000051",
    project_id: null,
    target_session_id: parentId,
    target_native_id: null,
    target_backend: "codex",
    sender_kind: "system",
    sender_session_id: stoppedChildId,
    sender_native_id: null,
    sender_backend: "codex",
    sender_label: "child session Legacy cleanup",
    body: [
      `[orc child-session id=${stoppedChildId} outcome=stopped]`,
      'Child session "Legacy cleanup" stopped.',
      "",
      "Last reply:",
      "Stopped after cleaning 2 stale lock files.",
      "",
      `Read more with session_status {"session_id":"${stoppedChildId}"}; reply with session_send.`,
    ].join("\n"),
    position: 0,
    hop: 0,
    state: "delivered",
    delivered_via: "chat",
    delivery_error: null,
    request_id: null,
    created_at: now - 50_000,
    updated_at: now - 50_000,
    delivered_at: now - 50_000,
  });

  const finishedDelivery: SessionDelivery = {
    id: "del-1",
    kind: "child_outcome",
    session_id: childId,
    title: "Fix auth retry race",
    outcome: "finished",
    summary: "Resolved the token refresh lock race and verified all 18 tests pass.",
    body: [
      "### Auth retry fix",
      "",
      "Replaced the unsynchronized refresh promise with a single-flight lock.",
      "",
      "- Added regression test for concurrent 401 bursts",
      "- Verified 18/18 unit tests pass",
    ].join("\n"),
    timestamp: now - 90_000,
  };

  const failedDelivery: SessionDelivery = {
    id: "del-2",
    kind: "child_outcome",
    session_id: failedChildId,
    title: "Migrate billing fixtures",
    outcome: "failed",
    summary: "Typecheck failed in packages/api/src/billing.ts (TS2322)",
    body: "Build failed with `TS2322` on line 84 while migrating billing fixtures.",
    timestamp: now - 80_000,
  };

  const waitingDelivery: SessionDelivery = {
    id: "del-3",
    kind: "child_outcome",
    session_id: waitingChildId,
    title: "Deploy staging preview",
    outcome: "waiting",
    waiting_for: "approval",
    summary: "Waiting for human approval",
    body: "Child session is paused waiting for human approval to run `bun run deploy:staging`.",
    timestamp: now - 70_000,
  };

  const relayDelivery: SessionDelivery = {
    id: "del-4",
    kind: "relay",
    session_id: null,
    title: "human relay (ORC web)",
    summary: "Prioritize the billing failure before starting staging deploy.",
    body: "Prioritize the billing failure before starting staging deploy. Keep the staging worker paused until CI is green.",
    sender_kind: "human",
    timestamp: now - 60_000,
  };

  seedThread(
    makeThread(
      parentId,
      "Factory coordinator",
      [
        {
          id: `${parentId}-u1`,
          role: "user",
          content: "Fan out the auth fix, billing migration, and staging preview.",
          timestamp: now - 180_000,
        },
        {
          id: `${parentId}-a1`,
          role: "assistant",
          content: "Started three worker sessions and waiting for their outcomes.",
          timestamp: now - 170_000,
        },
        {
          id: `${parentId}-d1`,
          role: "user",
          content: "ORC delivered a message...",
          deliveries: [finishedDelivery, failedDelivery],
          timestamp: now - 80_000,
        },
        {
          id: `${parentId}-d2`,
          role: "user",
          content: "ORC delivered a message...",
          deliveries: [waitingDelivery],
          timestamp: now - 70_000,
        },
        {
          id: `${parentId}-d3`,
          role: "user",
          content: "ORC delivered a message...",
          deliveries: [relayDelivery],
          timestamp: now - 60_000,
        },
        {
          id: `${parentId}-d4`,
          role: "user",
          content: sessionMessageContext([legacyNotice]),
          timestamp: now - 50_000,
        },
        {
          id: `${parentId}-a2`,
          role: "assistant",
          content: "Auth retry is green; I will inspect the billing TypeScript error next.",
          timestamp: now - 40_000,
        },
      ],
      now - 40_000,
    ),
  );

  await openChatThread(page, parentId, 1440, 900);

  const cards = page.getByTestId("chat-delivery-card");
  await expect(cards).toHaveCount(5);

  for (let i = 0; i < 5; i++) {
    await expect(cards.nth(i)).toHaveAttribute("data-expanded", "false");
    await expect(cards.nth(i).getByTestId("chat-delivery-body")).toHaveCount(0);
  }

  await expect(cards.nth(0)).toHaveAttribute("data-outcome", "finished");
  await expect(cards.nth(0).getByTestId("chat-delivery-outcome")).toHaveText("Finished");
  await expect(cards.nth(1)).toHaveAttribute("data-outcome", "failed");
  await expect(cards.nth(1).getByTestId("chat-delivery-outcome")).toHaveText("Failed");
  await expect(cards.nth(2)).toHaveAttribute("data-outcome", "waiting");
  await expect(cards.nth(2).getByTestId("chat-delivery-outcome")).toHaveText("Waiting · approval");
  await expect(cards.nth(3)).toHaveAttribute("data-outcome", "relay");
  await expect(cards.nth(3).getByTestId("chat-delivery-outcome")).toHaveText("Relay");
  await expect(cards.nth(4)).toHaveAttribute("data-outcome", "stopped");
  await expect(cards.nth(4).getByTestId("chat-delivery-outcome")).toHaveText("Stopped");

  const screenshotDir = process.env.ORC_SCREENSHOT_DIR;
  if (screenshotDir) {
    await page.screenshot({ path: `${screenshotDir}/deliveries-desktop.png` });
  }

  await cards.nth(0).getByTestId("chat-delivery-toggle").click();
  await expect(cards.nth(0)).toHaveAttribute("data-expanded", "true");
  await expect(cards.nth(0).getByTestId("chat-delivery-body")).toContainText("single-flight lock");

  if (screenshotDir) {
    await page.screenshot({ path: `${screenshotDir}/deliveries-desktop-expanded.png` });
  }

  await openChatThread(page, parentId, 390, 844);
  await expect(page.getByTestId("chat-delivery-card")).toHaveCount(5);
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflows).toBe(false);
  if (screenshotDir) {
    await page.screenshot({ path: `${screenshotDir}/deliveries-phone.png` });
  }

  const link = page
    .getByTestId("chat-delivery-card")
    .first()
    .getByTestId("chat-delivery-session-link");
  await expect(link).toHaveAttribute("href", `/chat?chatThread=${encodeURIComponent(childId)}`);
  await link.click();
  await expect(page.getByTestId("chat-messages")).toContainText(
    "Resolved the token refresh lock race and verified all 18 tests pass.",
  );
});

test("shows queued agent messages in the pending disclosure with Deliver now and Cancel", async ({
  page,
}) => {
  const now = Date.now();
  const threadId = crypto.randomUUID();
  const childId = crypto.randomUUID();

  seedThread(
    makeThread(
      threadId,
      "Coordinator with pending child notes",
      [
        {
          id: `${threadId}-u1`,
          role: "user",
          content: "Run the release checklist",
          timestamp: now - 30_000,
        },
        {
          id: `${threadId}-a1`,
          role: "assistant",
          content: "Working through the checklist.",
          timestamp: now - 20_000,
        },
      ],
      now - 20_000,
    ),
  );

  let queuedMessages = [
    {
      id: "01J00000000000000000000081",
      project_id: null,
      target_session_id: threadId,
      target_native_id: null,
      target_backend: "codex",
      sender_kind: "system",
      sender_session_id: childId,
      sender_native_id: null,
      sender_backend: "codex",
      sender_label: "child session Build worker",
      body: "[orc child-session id=pw-queue-child outcome=finished]\nDone.",
      delivery: {
        kind: "child_outcome",
        session_id: childId,
        title: "Build worker",
        outcome: "finished",
        summary: "Compiled CLI and web bundles cleanly",
      },
      position: 0,
      hop: 0,
      state: "queued",
      delivered_via: null,
      delivery_error: null,
      request_id: null,
      created_at: now - 5_000,
      updated_at: now - 5_000,
      delivered_at: null,
    },
  ];
  let cancelledId: string | null = null;

  await page.route(`**/api/sessions/live/${threadId}/messages`, (route) =>
    route.fulfill({ json: { messages: queuedMessages } }),
  );
  await page.route("**/api/session-messages/*/cancel", (route) => {
    const id = route.request().url().split("/").slice(-2)[0] ?? null;
    cancelledId = id;
    queuedMessages = queuedMessages.filter((entry) => entry.id !== id);
    return route.fulfill({ json: { id, state: "cancelled" } });
  });

  await openChatThread(page, threadId, 1440, 900);

  const queue = page.getByTestId("chat-message-queue");
  await expect(queue).toBeVisible();
  await expect(page.getByTestId("chat-pending-count")).toContainText("1 pending");
  await page.getByTestId("chat-queue-toggle").click();

  const row = page.getByTestId("chat-queued-session-message");
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("chat-queued-session-sender")).toHaveText("Build worker");
  await expect(row.getByTestId("chat-queued-session-summary")).toContainText(
    "Compiled CLI and web bundles cleanly",
  );
  await expect(row.getByTestId("chat-queued-deliver-now")).toBeVisible();
  await expect(row.getByTestId("chat-queued-deliver-now")).toBeDisabled();

  const screenshotDir = process.env.ORC_SCREENSHOT_DIR;
  if (screenshotDir) {
    await page.screenshot({ path: `${screenshotDir}/deliveries-queue-desktop.png` });
  }

  await row.getByTestId("chat-queued-session-cancel").click();
  await expect.poll(() => cancelledId).toBe("01J00000000000000000000081");
  await expect(page.getByTestId("chat-message-queue")).toHaveCount(0);
});
