import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPackage,
  packageRevision,
  readPackage,
  updatePackage,
} from "@orc/core/package-service";
import { reloadCache } from "@orc/core/skill-service";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof setupTestApp>;
const original = process.env.ORC_PACKAGES_DIR;
beforeAll(() => {
  process.env.ORC_PACKAGES_DIR = join(mkdtempSync(join(tmpdir(), "orc-delete-api-")), "packages");
  app = setupTestApp();
});
afterAll(() => {
  teardownTestApp();
  if (original === undefined) delete process.env.ORC_PACKAGES_DIR;
  else process.env.ORC_PACKAGES_DIR = original;
  reloadCache();
});

test("package deletion requires auth and a valid current revision, then removes the catalog entry", async () => {
  const current = createPackage("delete-api", "name: delete-api\nversion: 1.0.0\n", []);
  const path = `/agent-packages/${current.name}`;
  const input = { expectedRevision: packageRevision(current) };
  expect(
    (
      await app.request(`/api${path}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      })
    ).status,
  ).toBe(401);
  expect((await req(app, "DELETE", path, {})).status).toBe(400);
  expect((await req(app, "DELETE", path, { expectedRevision: "invalid" })).status).toBe(400);
  expect((await req(app, "DELETE", path, { expectedRevision: "0".repeat(64) })).status).toBe(409);
  expect(readPackage(current.name)).not.toBeNull();
  expect((await req(app, "DELETE", path, input)).status).toBe(204);
  expect((await req(app, "GET", path)).status).toBe(404);
  expect((await req(app, "DELETE", path, input)).status).toBe(404);
});

test("a package edited after deletion was requested survives the stale request", async () => {
  const current = createPackage("changed-api", "name: changed-api\nversion: 1.0.0\n", []);
  const revision = packageRevision(current);
  updatePackage(current.name, {
    expectedRevision: revision,
    content: "name: changed-api\nversion: 2.0.0\n",
    files: [],
  });
  expect(
    (await req(app, "DELETE", `/agent-packages/${current.name}`, { expectedRevision: revision }))
      .status,
  ).toBe(409);
  expect(readPackage(current.name)?.manifest.version).toBe("2.0.0");
  expect(
    (
      await req(app, "DELETE", "/agent-packages/nested%2Fchanged-api", {
        expectedRevision: revision,
      })
    ).status,
  ).toBe(400);
});
