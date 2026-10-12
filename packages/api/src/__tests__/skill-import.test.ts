import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getUserSkillsDir, reloadCache } from "@orc/core/skill-service";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

const name = `github-import-${process.pid}`;
const unsafeName = `${name}-unsafe`;
const commit = "a".repeat(40);
let currentCommit = commit;
let mode = "100644";
let truncated = false;
let oversized = false;
const files = new Map<string, Buffer>([
  [
    `skills/${name}/SKILL.md`,
    Buffer.from(`\uFEFF---\nname: ${name}\ndescription: GitHub test\n---\nOriginal instructions`),
  ],
  [`skills/${name}/references/deep/guide.md`, Buffer.from("Original guide")],
  [`skills/${name}/assets/sample.bin`, Buffer.from([0, 255, 128])],
]);
let app: ReturnType<typeof createApp>;
let fetchMock: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

beforeAll(() => {
  app = setupTestApp();
  fetchMock = spyOn(globalThis, "fetch").mockImplementation((async (
    input: string | URL | Request,
  ) => {
    const url = String(input);
    if (url.startsWith("https://api.github.com/repos/acme/skills/commits/"))
      return Response.json({ sha: currentCommit });
    if (url.startsWith("https://api.github.com/repos/acme/skills/git/trees/"))
      return Response.json({
        truncated,
        tree: [...files.entries()].map(([path, bytes]) => ({
          path,
          type: "blob",
          mode: path.endsWith("escape.ts") ? "120000" : mode,
          sha: "c".repeat(40),
          size: oversized ? 9 * 1024 * 1024 : bytes.length,
        })),
      });
    if (url.startsWith("https://raw.githubusercontent.com/acme/skills/")) {
      const path = url.split("/").slice(6).map(decodeURIComponent).join("/");
      const file = files.get(path);
      return new Response(file ? new Uint8Array(file) : null, { status: file ? 200 : 404 });
    }
    throw new Error(`Unexpected remote request: ${url}`);
  }) as typeof fetch);
});
afterAll(() => {
  fetchMock.mockRestore();
  for (const value of [name, unsafeName]) {
    rmSync(join(getUserSkillsDir(), value), { recursive: true, force: true });
    rmSync(join(homedir(), ".orc", "skill-imports", `${value}.json`), { force: true });
  }
  reloadCache();
  teardownTestApp();
});

test("should authenticate every new operation and reject unsafe input", async () => {
  for (const [method, path, body] of [
    ["POST", "/skills/discover", { source: "acme/skills" }],
    ["POST", "/skills/import", { source: "acme/skills", commit, paths: [`skills/${name}`] }],
    ["GET", `/skills/${name}/origin`, undefined],
    ["POST", `/skills/${name}/sync`, {}],
    ["PUT", `/skills/${name}/file`, { path: "SKILL.md", content: "edit", expectedContent: "old" }],
  ] as const)
    expect(
      (
        await app.request(`/api${path}`, {
          method,
          headers: { "Content-Type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        })
      ).status,
    ).toBe(401);
  expect(
    (await req(app, "POST", "/skills/discover", { source: "https://localhost/secret" })).status,
  ).toBe(400);
  expect(
    (
      await req(app, "POST", "/skills/import", {
        source: "acme/skills",
        commit,
        paths: ["../escape"],
      })
    ).status,
  ).toBe(400);
});

test("should import, edit, sync, report conflicts and override only reviewed versions", async () => {
  const discovered = await req(app, "POST", "/skills/discover", { source: "acme/skills" });
  expect(discovered.status).toBe(200);
  expect((await discovered.json()).skills).toEqual([
    { name, description: "GitHub test", path: `skills/${name}`, installed: false },
  ]);
  const imported = await req(app, "POST", "/skills/import", {
    source: "acme/skills",
    commit,
    paths: [`skills/${name}`],
  });
  expect(imported.status).toBe(201);
  expect((await imported.json()).skills[0].files).toHaveLength(2);
  expect(readFileSync(join(getUserSkillsDir(), name, "SKILL.md")).toString("base64")).toBe(
    files.get(`skills/${name}/SKILL.md`)?.toString("base64") ?? "",
  );
  expect(readFileSync(join(getUserSkillsDir(), name, "assets/sample.bin"))).toEqual(
    Buffer.from([0, 255, 128]),
  );
  const origin = await req(app, "GET", `/skills/${name}/origin`);
  const provenance = await origin.json();
  expect(provenance).toMatchObject({ repository: "acme/skills", commit, path: `skills/${name}` });
  expect(provenance.files).toBeUndefined();
  expect(
    (
      await req(app, "POST", "/skills/import", {
        source: "acme/skills",
        commit,
        paths: [`skills/${name}`],
      })
    ).status,
  ).toBe(409);
  const entry = files.get(`skills/${name}/SKILL.md`)?.toString() as string;
  const local = entry.replace("Original instructions", "My custom instructions");
  expect(
    (
      await req(app, "PUT", `/skills/${name}/file`, {
        path: "SKILL.md",
        content: local,
        expectedContent: entry,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await req(app, "PUT", `/skills/${name}/file`, {
        path: "SKILL.md",
        content: entry,
        expectedContent: entry,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await req(app, "PUT", `/skills/${name}/file`, {
        path: "../secret",
        content: "x",
        expectedContent: "",
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await req(app, "PUT", `/skills/${name}/file`, {
        path: "assets/sample.bin",
        content: "x",
        expectedContent: "AP+A",
      })
    ).status,
  ).toBe(400);
  currentCommit = "b".repeat(40);
  files.set(`skills/${name}/references/deep/guide.md`, Buffer.from("Updated upstream guide"));
  expect((await (await req(app, "POST", `/skills/${name}/sync`, {})).json()).applied).toBe(true);
  expect(readFileSync(join(getUserSkillsDir(), name, "SKILL.md"), "utf8")).toBe(local);
  expect(readFileSync(join(getUserSkillsDir(), name, "references/deep/guide.md"), "utf8")).toBe(
    "Updated upstream guide",
  );
  files.set(
    `skills/${name}/SKILL.md`,
    Buffer.from(entry.replace("Original instructions", "New upstream instructions")),
  );
  currentCommit = "d".repeat(40);
  const conflict = await (await req(app, "POST", `/skills/${name}/sync`, {})).json();
  expect(conflict).toMatchObject({ applied: false, conflicts: ["SKILL.md"] });
  expect(readFileSync(join(getUserSkillsDir(), name, "SKILL.md"), "utf8")).toBe(local);
  expect((await req(app, "POST", `/skills/${name}/sync`, { override: true })).status).toBe(409);
  currentCommit = "e".repeat(40);
  expect(
    (
      await req(app, "POST", `/skills/${name}/sync`, {
        override: true,
        expectedCommit: conflict.commit,
        expectedRevision: conflict.revision,
      })
    ).status,
  ).toBe(409);
  const reviewed = await (await req(app, "POST", `/skills/${name}/sync`, {})).json();
  const locallyUpdated = `${local}\nAnother local edit`;
  expect(
    (
      await req(app, "PUT", `/skills/${name}/file`, {
        path: "SKILL.md",
        content: locallyUpdated,
        expectedContent: local,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await req(app, "POST", `/skills/${name}/sync`, {
        override: true,
        expectedCommit: reviewed.commit,
        expectedRevision: reviewed.revision,
      })
    ).status,
  ).toBe(409);
  const freshReview = await (await req(app, "POST", `/skills/${name}/sync`, {})).json();
  const overridden = await req(app, "POST", `/skills/${name}/sync`, {
    override: true,
    expectedCommit: freshReview.commit,
    expectedRevision: freshReview.revision,
  });
  expect(overridden.status).toBe(200);
  expect((await overridden.json()).applied).toBe(true);
  expect(readFileSync(join(getUserSkillsDir(), name, "SKILL.md"), "utf8")).toContain(
    "New upstream instructions",
  );
  expect((await (await req(app, "GET", `/skills/${name}`)).json()).content).toBe(
    "New upstream instructions",
  );
});

test("should reject symlinks before creating an import", async () => {
  files.clear();
  files.set(
    `skills/${unsafeName}/SKILL.md`,
    Buffer.from(`---\nname: ${unsafeName}\ndescription: Unsafe\n---\nBody`),
  );
  mode = "100644";
  files.set(`skills/${unsafeName}/scripts/escape.ts`, Buffer.from("../../../outside"));
  expect(
    (
      await req(app, "POST", "/skills/import", {
        source: "acme/skills",
        commit,
        paths: [`skills/${unsafeName}`],
      })
    ).status,
  ).toBe(400);
  expect(existsSync(join(getUserSkillsDir(), unsafeName))).toBe(false);
});

test("should reject truncated trees and oversized files without creating skills", async () => {
  truncated = true;
  expect((await req(app, "POST", "/skills/discover", { source: "acme/skills" })).status).toBe(400);
  truncated = false;
  files.delete(`skills/${unsafeName}/scripts/escape.ts`);
  oversized = true;
  expect(
    (
      await req(app, "POST", "/skills/import", {
        source: "acme/skills",
        commit,
        paths: [`skills/${unsafeName}`],
      })
    ).status,
  ).toBe(400);
  expect(existsSync(join(getUserSkillsDir(), unsafeName))).toBe(false);
});
