/**
 * Demo seed for the mobile screenshots (paired with capture-mobile-screens.ts).
 * Populates an ISOLATED preview ORC instance with projects, tasks, human
 * requests and notifications so the captures show realistic grouped inboxes.
 *
 * Usage:
 *   1. Start a preview API + web dev server against a disposable ORC_HOME/DB
 *      (e.g. ports 7711/3087 with ORC_DB_PATH=<temp>/orc.db).
 *   2. ORC_DEMO_SEED=1 ORC_DB_PATH=<temp>/orc.db bun packages/web/scripts/seed-mobile-demo.ts
 *   3. bun packages/web/scripts/capture-mobile-screens.ts
 *
 * Env: PREVIEW_API (default http://127.0.0.1:7711), ORC_DB_PATH (required),
 *      ORC_DEMO_SEED=1 (required opt-in).
 *
 * Safety: clears the notification tables of the target database so re-runs are
 * deterministic (source_key idempotency would otherwise keep dismissed rows).
 * Refuses to run without the explicit opt-in; never point it at a real workspace.
 */
import { Database } from "bun:sqlite";
import { NotificationStore } from "@orc/db/notifications";

const API = `${process.env.PREVIEW_API ?? "http://127.0.0.1:7711"}/api`;
const dbPath = process.env.ORC_DB_PATH;
if (!dbPath) throw new Error("ORC_DB_PATH must point at the isolated preview database");
if (process.env.ORC_DEMO_SEED !== "1")
  throw new Error("Set ORC_DEMO_SEED=1 to confirm the target is a disposable preview database");

async function post(path: string, body: unknown) {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} -> ${response.status}: ${await response.text()}`);
  return response.json();
}

const now = Date.now();
const hour = 3_600_000;

// Retire previous requests so re-runs never accumulate stale pending cards.
// Origin identities are idempotent, so each run also uses fresh request ids.
const previousRequests = (await (await fetch(`${API}/human-requests`)).json()) as Array<{
  id: string;
  version: number;
  status: string;
}>;
for (const request of previousRequests)
  if (request.status === "pending")
    await fetch(`${API}/human-requests/${request.id}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: request.version }),
    });

// Disposable preview DB: clear the inbox so re-runs are deterministic.
const db = new Database(dbPath);
db.exec("DELETE FROM notifications; DELETE FROM notification_session_sources;");
const store = new NotificationStore(db);

const billing = (await post("/projects", { name: "billing-api" })) as { id: string };
const console_ = (await post("/projects", { name: "web-console" })) as { id: string };

await post("/tasks", {
  title: "Retry flaky invoice export",
  project_id: billing.id,
  status: "in-progress",
  priority: "high",
});
await post("/tasks", {
  title: "Add proration to plan upgrades",
  project_id: billing.id,
  status: "todo",
  priority: "normal",
});
await post("/tasks", {
  title: "Ship nightly compaction report",
  project_id: billing.id,
  status: "done",
  priority: "low",
});
await post("/tasks", {
  title: "Fix booking sheet jump on resize",
  project_id: console_.id,
  status: "in-progress",
  priority: "critical",
});
await post("/tasks", {
  title: "Pick a cache strategy for session lists",
  project_id: console_.id,
  status: "todo",
  priority: "high",
});
await post("/tasks", {
  title: "Dark theme contrast audit",
  project_id: console_.id,
  status: "todo",
  priority: "normal",
});

await post("/human-requests", {
  kind: "approval",
  title: "Run the database migration",
  prompt: "Apply migration 0042 to the billing database?",
  project_id: billing.id,
  origin: { session_id: "demo-session-1", backend: "codex", request_id: `demo-approval-${now}` },
  action: {
    tool: "shell",
    cwd: "/srv/billing",
    host: "local",
    input: { command: "bun run migrate" },
  },
});
await post("/human-requests", {
  kind: "question",
  title: "Which cache should the console use?",
  prompt: "Session lists refetch on every focus. Pick a caching strategy.",
  project_id: console_.id,
  origin: { session_id: "demo-session-2", backend: "claude", request_id: `demo-question-${now}` },
  choices: ["Keep refetching", "Stale-while-revalidate", "Cache until invalidated"],
});

function publish(
  type: string,
  source: string,
  title: string,
  body: string,
  level: "needs-you" | "done",
  path: string,
  ageHours: number,
  requiresAction: boolean,
  projectId: string | null,
) {
  const createdAt = now - Math.round(ageHours * hour);
  store.publish({
    type,
    source_key: `demo:${source}:${ageHours}`,
    source_id: source,
    title,
    body,
    level,
    project_id: projectId,
    path,
    requires_action: requiresAction,
    created_at: createdAt,
    expires_at: createdAt + 7 * 24 * hour,
  });
}

// One session with mixed outcomes collapses into a grouped summary row.
publish(
  "agent.failed",
  "demo-live-3",
  "Booking sheet jumps",
  "Provider exited with code 1.",
  "needs-you",
  "/sessions?session=demo-live-3",
  2,
  true,
  console_.id,
);
publish(
  "agent.finished",
  "demo-live-3",
  "Booking sheet jumps",
  "Recovered and finished the turn.",
  "done",
  "/sessions?session=demo-live-3",
  0.05,
  false,
  console_.id,
);
publish(
  "agent.question",
  "demo-live-4",
  "Cache strategy question",
  "Waiting for a decision on session-list caching.",
  "needs-you",
  "/sessions?session=demo-live-4",
  0.5,
  true,
  console_.id,
);
publish(
  "agent.finished",
  "demo-live-1",
  "Flaky billing retry test",
  "Tests passed on all 5 runs.",
  "done",
  "/sessions?session=demo-live-1",
  0.2,
  false,
  billing.id,
);
publish(
  "agent.finished",
  "demo-live-2",
  "Nightly compaction",
  "Compacted 1.2 GB and refreshed statistics.",
  "done",
  "/sessions?session=demo-live-2",
  1,
  false,
  billing.id,
);
publish(
  "job.finished",
  "demo-job-1",
  "Invoice PDF export",
  "Exported 238 invoices to the archive.",
  "done",
  "/jobs",
  3,
  false,
  billing.id,
);

db.close();
console.log("Seeded demo projects, tasks, requests and notifications.");
