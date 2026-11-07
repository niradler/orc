import { afterAll, beforeAll, expect, test } from "bun:test";
import { AuditLog, cleanupAuditLog } from "@orc/db/audit";
import { getSqlite } from "@orc/db/client";
import { NotificationStore } from "@orc/db/notifications";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof setupTestApp>;
beforeAll(() => {
  app = setupTestApp();
});
afterAll(teardownTestApp);

test("should require authentication for notification audit history", async () => {
  const response = await app.request("/api/audit?entity_type=notification");
  expect(response.status).toBe(401);
});

test("should expose notification audit entries after the alert expires without mixing entity filters", async () => {
  const sqlite = getSqlite();
  let now = Date.now();
  const notifications = new NotificationStore(sqlite, () => now);
  sqlite.query("INSERT INTO projects(id,name) VALUES (?,?)").run("audit-project", "Audit project");
  const original = now;
  const item = notifications.publish({
    type: "job.finished",
    source_key: "audit-api-job:one",
    source_id: "run-one",
    title: "Search index job finished",
    body: "The scheduled search index completed successfully.",
    level: "done",
    path: "/jobs?run=run-one",
    project_id: "audit-project",
    created_at: original,
    expires_at: original + 1,
  });
  if (!item) throw new Error("Expected notification before expiry");
  new AuditLog(sqlite).record({ action: "memory.updated", subject_ids: ["different-entity"] });
  now += 1;
  expect(notifications.cleanup()).toBe(1);
  const response = await req(app, "GET", "/audit?entity_type=notification&scope=all");
  expect(response.status).toBe(200);
  const body = await response.json<{
    entries: { action: string; subject_ids: string[]; snapshot: { title: string; body: string } }[];
  }>();
  expect(body.entries.map((entry) => entry.action)).toEqual([
    "notification.expired",
    "notification.created",
  ]);
  expect(body.entries.every((entry) => entry.subject_ids.includes(item.id))).toBe(true);
  expect(body.entries.every((entry) => entry.snapshot.title === "Search index job finished")).toBe(
    true,
  );
  expect(
    body.entries.every(
      (entry) => entry.snapshot.body === "The scheduled search index completed successfully.",
    ),
  ).toBe(true);
  const globalResponse = await req(app, "GET", "/audit?entity_type=notification&scope=global");
  expect(await globalResponse.json()).toEqual({ entries: [] });
  expect(cleanupAuditLog(sqlite, 90, Date.now())).toBe(0);
});

test("should return bounded previews and retain full legacy audit snapshots", async () => {
  const original = "previous skill file ".repeat(10000);
  new AuditLog(getSqlite()).record({
    action: "skill.file_updated",
    subject_ids: ["large-skill"],
    snapshot: { previous_content: original },
  });
  const preview = await req(app, "GET", "/audit?scope=all&entity_type=skill&snapshot=preview");
  expect(preview.status).toBe(200);
  const previewText = await preview.text();
  expect(previewText).toContain('"preview_truncated":true');
  expect(previewText.length).toBeLessThan(2000);
  const full = await req(app, "GET", "/audit?scope=all&entity_type=skill");
  expect(full.status).toBe(200);
  expect(await full.json()).toMatchObject({
    entries: [{ snapshot: { previous_content: original } }],
  });
});
