import { afterAll, beforeAll, expect, test } from "bun:test";
import type { HealthResponse, RestartResponse } from "@orc/sdk/types";
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
