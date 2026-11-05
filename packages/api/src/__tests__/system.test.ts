import { afterAll, beforeAll, expect, test } from "bun:test";
import type { HealthResponse, RestartResponse, SystemAbout } from "@orc/sdk/types";
import { registerRestartHandler } from "../lifecycle.js";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;
beforeAll(() => {
  app = setupTestApp();
});
afterAll(() => {
  registerRestartHandler(undefined);
  teardownTestApp();
});

test("should protect restart, validate input, reject unavailable/duplicate restarts and acknowledge before shutdown", async () => {
  expect((await app.request("/api/system/restart", { method: "POST" })).status).toBe(401);
  expect((await req(app, "POST", "/system/restart", { command: "arbitrary command" })).status).toBe(
    400,
  );
  expect((await req(app, "POST", "/system/restart", {})).status).toBe(503);
  expect((await (await req(app, "GET", "/health")).json()).restart_supported).toBe(false);
  let calls = 0;
  registerRestartHandler(async () => {
    calls++;
  });
  const health = await (await req(app, "GET", "/health")).json<HealthResponse>();
  expect(health.restart_supported).toBe(true);
  const response = await req(app, "POST", "/system/restart", {});
  expect(response.status).toBe(202);
  const result = await response.json<RestartResponse>();
  expect(result).toEqual({ instance_id: health.instance_id, restarting: true });
  expect(calls).toBe(0);
  expect((await req(app, "POST", "/system/restart", {})).status).toBe(409);
  await Bun.sleep(300);
  expect(calls).toBe(1);
});

test("should describe the server build and environment to signed-in clients only", async () => {
  expect((await app.request("/api/system/about")).status).toBe(401);
  const response = await req(app, "GET", "/system/about");
  expect(response.status).toBe(200);
  const about = await response.json<SystemAbout>();
  const health = await (await req(app, "GET", "/health")).json<HealthResponse>();
  expect(about).toMatchObject({
    version: health.version,
    platform: process.platform,
    arch: process.arch,
    instance_id: health.instance_id,
  });
  expect(about.runtime).toStartWith("bun ");
  expect(about.data_dir.length).toBeGreaterThan(0);
});
