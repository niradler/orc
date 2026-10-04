import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteAgent, discoverAgents } from "./agent-service.js";

describe("project agent deletion", () => {
  const project = mkdtempSync(join(tmpdir(), "orc-agent-delete-"));
  const directory = join(project, ".apm", "agents");
  const content = "---\nname: Reviewer\ndescription: Project reviewer\n---\nReview.";
  afterAll(() => rmSync(project, { recursive: true, force: true }));

  test("should delete a nested project profile and preserve profiles with the same name", () => {
    mkdirSync(join(directory, "nested"), { recursive: true });
    writeFileSync(join(directory, "nested", "first.agent.md"), content);
    writeFileSync(join(directory, "second.agent.md"), content);
    deleteAgent("nested/first", project);
    expect(existsSync(join(directory, "nested", "first.agent.md"))).toBe(false);
    expect(existsSync(join(directory, "second.agent.md"))).toBe(true);
    expect(discoverAgents(project).agents.some((agent) => agent.id === "nested/first")).toBe(false);
    expect(() => deleteAgent("nested/first", project)).toThrow("not found");
    expect(() => deleteAgent("nested/../second", project)).toThrow("Invalid");
  });

  test("should refuse a project whose parent directory redirects through a symlink", () => {
    const alias = join(project, "alias");
    symlinkSync(join(project, ".apm"), alias, "junction");
    const linkedProject = join(project, "linked-project");
    mkdirSync(linkedProject);
    symlinkSync(alias, join(linkedProject, ".apm"), "junction");
    expect(() => deleteAgent("second", linkedProject)).toThrow();
    expect(existsSync(join(directory, "second.agent.md"))).toBe(true);
    const projectAlias = join(project, "project-alias");
    symlinkSync(project, projectAlias, "junction");
    expect(() => deleteAgent("second", projectAlias)).toThrow("symlinks");
    expect(existsSync(join(directory, "second.agent.md"))).toBe(true);
  });
});
