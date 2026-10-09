import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resetConfig } from "@orc/core/config";
import { closeDb, createTestDb, getDb } from "@orc/db/client";
import { memories, projects, sessions } from "@orc/db/schema";
import { getLayer2, getLayer3, searchLayer1 } from "../search.js";
import { executeTool } from "../tools.js";

beforeAll(async () => {
  process.env.ORC_DB_PATH = ":memory:";
  resetConfig();
  const db = createTestDb();
  await db.insert(projects).values([
    { id: "validity-a", name: "validity-a" },
    { id: "validity-b", name: "validity-b" },
  ]);
});

afterAll(() => {
  closeDb();
  delete process.env.ORC_DB_PATH;
  resetConfig();
});

describe("Memory eligibility", () => {
  test("should fail closed for an unknown requested project", async () => {
    await expect(executeTool("context", { project: "missing-validity-project" })).rejects.toThrow(
      "Project not found",
    );
  });
  test("should exclude expired evidence from every search layer without losing historical reads", async () => {
    const db = getDb();
    await db.insert(memories).values([
      {
        id: "expired-evidence",
        content: "validityneedle punctuation::needle",
        expires_at: new Date(Date.now() - 60_000),
      },
      {
        id: "current-evidence",
        content: "validityneedle punctuation::needle",
        expires_at: new Date(Date.now() + 60_000),
      },
    ]);
    for (const query of ["validityneedle", "idityneed", "punctuation::needle"]) {
      const ids = searchLayer1(query).map((result) => result.id);
      expect(ids).toContain("current-evidence");
      expect(ids).not.toContain("expired-evidence");
    }
    expect(getLayer3(["expired-evidence"])[0]?.id).toBe("expired-evidence");
  });

  test("should isolate timeline neighbors including the unassigned project", async () => {
    const now = Date.now();
    await getDb()
      .insert(memories)
      .values([
        {
          id: "timeline-target",
          content: "target",
          project_id: "validity-a",
          created_at: new Date(now - 20_000),
        },
        {
          id: "timeline-before",
          content: "before",
          project_id: "validity-a",
          created_at: new Date(now - 30_000),
        },
        {
          id: "timeline-after",
          content: "after",
          project_id: "validity-a",
          created_at: new Date(now - 10_000),
        },
        {
          id: "timeline-other",
          content: "other",
          project_id: "validity-b",
          created_at: new Date(now - 15_000),
        },
        { id: "timeline-global", content: "global", created_at: new Date(now - 15_000) },
        {
          id: "timeline-expired",
          content: "expired",
          project_id: "validity-a",
          created_at: new Date(now - 12_000),
          expires_at: new Date(now - 1_000),
        },
      ]);
    const timeline = getLayer2("timeline-target");
    expect(timeline?.before.map((item) => item.id)).toEqual(["timeline-before"]);
    expect(timeline?.after.map((item) => item.id)).toEqual(["timeline-after"]);
    const global = getLayer2("timeline-global");
    expect(
      [...(global?.before ?? []), ...(global?.after ?? [])].map((item) => item.id),
    ).not.toContain("timeline-target");
  });

  test("should rank all eligible memories before limiting startup context and scope its session", async () => {
    const now = Date.now();
    await getDb()
      .insert(memories)
      .values([
        {
          id: "standing-rule",
          title: "Standing critical rule",
          content: "standing rule",
          project_id: "validity-a",
          type: "rule",
          importance: "critical",
          created_at: new Date(now - 90 * 86_400_000),
        },
        {
          id: "expired-rule",
          title: "Expired critical rule",
          content: "expired",
          project_id: "validity-a",
          type: "rule",
          importance: "critical",
          expires_at: new Date(now - 1_000),
        },
        ...Array.from({ length: 40 }, (_, index) => ({
          id: `noise-${index}`,
          content: "routine",
          project_id: "validity-a",
          type: "event" as const,
          importance: "low" as const,
        })),
      ]);
    await getDb().insert(sessions).values({
      id: "other-session",
      agent: "test",
      project_id: "validity-b",
      summary: "PRIVATE OTHER PROJECT SUMMARY",
    });
    const context = await executeTool("context", { project: "validity-a" });
    expect(context).toContain("Standing critical rule");
    expect(context).not.toContain("Expired critical rule");
    expect(context).not.toContain("PRIVATE OTHER PROJECT SUMMARY");
  });
});
