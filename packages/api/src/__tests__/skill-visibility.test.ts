import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { globalConfigPath, hiddenBuiltinSkills, updateGlobalConfig } from "@orc/core/config";
import {
  getUserSkillsDir,
  listSkills,
  readSkill,
  reloadCache,
  type SkillRefContent,
} from "@orc/core/skill-service";
import { getSqlite } from "@orc/db/client";
import { SkillHistory } from "@orc/db/skill-history";
import { executeTool } from "@orc/mcp/tools";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;
let originalConfig: string | undefined;
const userSkillName = `visibility-user-${process.pid}`;
let createdVisibilitySkill = false;
beforeAll(() => {
  originalConfig = existsSync(globalConfigPath())
    ? readFileSync(globalConfigPath(), "utf8")
    : undefined;
  app = setupTestApp();
  reloadCache();
});
afterAll(() => {
  if (originalConfig !== undefined) writeFileSync(globalConfigPath(), originalConfig);
  else if (existsSync(globalConfigPath())) unlinkSync(globalConfigPath());
  rmSync(join(getUserSkillsDir(), userSkillName), { recursive: true, force: true });
  if (createdVisibilitySkill)
    rmSync(join(getUserSkillsDir(), "visibility"), { recursive: true, force: true });
  reloadCache();
  teardownTestApp();
});

test("should preserve named reads for a user skill called visibility", async () => {
  if (!readSkill("visibility")) {
    expect(
      (
        await req(app, "POST", "/skills", {
          name: "visibility",
          content:
            "---\nname: visibility\ndescription: Authored workflow\n---\nAuthored instructions",
        })
      ).status,
    ).toBe(201);
    createdVisibilitySkill = true;
  }
  expect((await (await req(app, "GET", "/skills/visibility?scope=global")).json()).name).toBe(
    "visibility",
  );
});

test("should default to visible and reject unauthenticated or invalid visibility writes", async () => {
  expect(
    (await req(app, "PUT", "/skills/settings/visibility", { hidden_builtins: [] })).status,
  ).toBe(200);
  expect(
    (
      await app.request("/api/skills/settings/visibility", {
        method: "PUT",
        body: JSON.stringify({ hidden_builtins: [] }),
        headers: { "Content-Type": "application/json" },
      })
    ).status,
  ).toBe(401);
  expect(
    (await req(app, "PUT", "/skills/settings/visibility", { hidden_builtins: ["missing"] })).status,
  ).toBe(400);
  expect(
    (
      await req(app, "PUT", "/skills/settings/visibility", {
        hidden_builtins: [],
        unexpected: true,
      })
    ).status,
  ).toBe(400);
  expect((await req(app, "GET", "/skills?include_hidden=false")).status).toBe(200);
  expect((await req(app, "GET", "/skills?include_hidden=invalid")).status).toBe(400);
});

test("should persist discovery visibility without changing reads, flows, user skills or unrelated config", async () => {
  updateGlobalConfig((raw) => {
    raw.visibility_test_marker = { value: "preserved" };
  });
  const flowsBefore = await (await req(app, "GET", "/flows")).json();
  const name = userSkillName;
  expect(
    (
      await req(app, "POST", "/skills", {
        name,
        content: `---\nname: ${name}\ndescription: User skill\n---\nUser instructions`,
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await req(app, "PUT", "/skills/settings/visibility", {
        hidden_builtins: ["orc-coder", "orc-worker-base", "orc-coder"],
      })
    ).status,
  ).toBe(200);
  const raw = JSON.parse(readFileSync(globalConfigPath(), "utf8"));
  expect(raw.skills.hidden_builtins).toEqual(["orc-coder", "orc-worker-base"]);
  expect(raw.visibility_test_marker).toEqual({ value: "preserved" });
  const catalog = await (await req(app, "GET", "/skills?scope=global")).json();
  expect(catalog.skills.some((skill: { name: string }) => skill.name === "orc-coder")).toBe(false);
  expect(catalog.skills.some((skill: { name: string }) => skill.name === name)).toBe(true);
  expect(listSkills().some((skill) => skill.name === "orc-coder")).toBe(false);
  expect(await executeTool("skill_list", { scope: "global" })).not.toContain("orc-coder");
  expect(await executeTool("skill_read", { name: "orc-coder", scope: "global" })).toContain(
    "# orc-coder",
  );
  expect(readSkill("orc-worker-base")).not.toBeNull();
  expect((await req(app, "GET", "/skills/orc-coder?scope=global&ref=SKILL.md")).status).toBe(200);
  const managed = await (await req(app, "GET", "/skills?include_hidden=true&scope=global")).json();
  expect(
    managed.skills.find((skill: { name: string }) => skill.name === "orc-coder").discovery_hidden,
  ).toBe(true);
  expect(await (await req(app, "GET", "/flows")).json()).toEqual(flowsBefore);
  // Simulate a separate MCP process having saved a new policy while API config is cached.
  updateGlobalConfig((config) => {
    config.skills = { hidden_builtins: ["orc-reviewer"] };
  });
  expect(await executeTool("skill_list", { scope: "global" })).toContain("orc-coder");
  expect(await executeTool("skill_list", { scope: "global" })).not.toContain("orc-reviewer");
});

test("should preserve global and project authored overrides during hide-all", async () => {
  const project = await (
    await req(app, "POST", "/projects", { name: `visibility-project-${process.pid}` })
  ).json();
  const history = new SkillHistory(getSqlite());
  for (const [name, project_id] of [
    ["orc-coder", null],
    ["orc-reviewer", project.id],
  ] as const) {
    const raw = readSkill(name, "SKILL.md") as SkillRefContent;
    history.update({
      skill_name: name,
      project_id,
      content: `${raw.content}\nAuthored override`,
      expected_content: raw.content,
      reason: "visibility preservation regression",
    });
  }
  const allBuiltins = listSkills({ source: "builtin", include_hidden: true }).map(
    (skill) => skill.name,
  );
  expect(
    (await req(app, "PUT", "/skills/settings/visibility", { hidden_builtins: allBuiltins })).status,
  ).toBe(200);
  const global = await executeTool("skill_list", { scope: "global" });
  expect(global).toContain("orc-coder");
  expect(global).not.toContain("orc-reviewer");
  const scoped = await executeTool("skill_list", { project: project.name });
  expect(scoped).toContain("orc-coder");
  expect(scoped).toContain("orc-reviewer");
  const apiScoped = await (await req(app, "GET", `/skills?project_id=${project.id}`)).json();
  expect(
    apiScoped.skills
      .filter((skill: { source: string }) => skill.source === "builtin")
      .map((skill: { name: string }) => skill.name),
  ).toEqual(["orc-coder", "orc-reviewer"]);
  expect(history.read("orc-reviewer", project.id)?.content).toContain("Authored override");
  const updated = history.read("orc-reviewer", project.id, "SKILL.md") as SkillRefContent;
  history.update({
    skill_name: "orc-reviewer",
    project_id: project.id,
    content: updated.content.replace(
      /description: .*\n/,
      "description: Unique authored visibility guidance\n",
    ),
    expected_content: updated.content,
    reason: "search uses effective description",
  });
  expect(
    await executeTool("skill_list", { project: project.name, q: "Unique authored visibility" }),
  ).toContain("orc-reviewer");
  expect(
    (await req(app, "PUT", "/skills/settings/visibility", { hidden_builtins: [] })).status,
  ).toBe(200);
  expect(listSkills({ source: "builtin" }).length).toBe(allBuiltins.length);
});

test("should retain retired hidden names during edits and fail loudly on corrupt config", async () => {
  updateGlobalConfig((raw) => {
    raw.skills = { hidden_builtins: ["retired-builtin"] };
  });
  expect(
    (
      await req(app, "PUT", "/skills/settings/visibility", {
        hidden_builtins: ["retired-builtin", "orc-coder"],
      })
    ).status,
  ).toBe(200);
  expect(hiddenBuiltinSkills()).toEqual(["orc-coder", "retired-builtin"]);
  const path = globalConfigPath();
  const saved = readFileSync(path, "utf8");
  try {
    writeFileSync(path, "{broken");
    expect(() => hiddenBuiltinSkills()).toThrow();
    expect(() => listSkills()).toThrow();
  } finally {
    writeFileSync(path, saved);
  }
});
