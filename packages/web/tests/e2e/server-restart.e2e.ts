import type { HealthResponse } from "@orc/sdk/types";
import { expect, test } from "@playwright/test";
import { apiGet, gotoView } from "./_helpers";

test("restarts the actual ORC process, reconnects and preserves workspace settings", async ({
  page,
  request,
}) => {
  const before = await apiGet<HealthResponse>(request, "/health");
  const preferences = await apiGet(request, "/settings");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await gotoView(page, "settings");
  await page.goto("/settings?settingsSection=server");
  await expect(page.getByTestId("workspace-connection-status")).toHaveText("Connected (local)");
  const restart = page.getByTestId("settings-restart");
  await expect(restart).toBeEnabled();
  await restart.click();
  await expect(page.getByTestId("settings-restart-status")).toHaveText(
    "ORC restarted. Reconnected.",
    { timeout: 30000 },
  );
  const after = await apiGet<HealthResponse>(request, "/health");
  expect(after.instance_id).not.toBe(before.instance_id);
  expect(await apiGet(request, "/settings")).toEqual(preferences);
  await expect(page.getByTestId("workspace-connection-status")).toHaveText("Connected (local)");
  await expect(restart).toBeEnabled();
  expect(errors).toEqual([]);
  await page.screenshot({ path: "../../.claude/docs/server-restart-desktop.png" });
});

test("shows saved SSH host changes immediately and never restarts automatically", async ({
  page,
}) => {
  let state = {
    host: null as string | null,
    remote_port: null,
    hosts: ["lab"],
    locked: false,
    supported: true,
    unsupported_reason: null,
    secret_set: true,
  };
  let restartRequests = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/system/restart")) restartRequests++;
  });
  await page.route("**/api/ssh", async (route) => {
    if (route.request().method() === "PUT") state = { ...state, ...route.request().postDataJSON() };
    await route.fulfill({ json: state });
  });
  await page.route("**/api/ssh/test", (route) =>
    route.fulfill({
      json: {
        ok: true,
        host: "lab",
        error: null,
        os: "linux",
        home: "/home/test",
        shell: "/bin/sh",
        binaries: {},
        claude_logged_in: null,
        api_key_forwarded: false,
      },
    }),
  );
  await gotoView(page, "settings");
  await page.goto("/settings?settingsSection=execution");
  await expect(page.getByTestId("workspace-connection-status")).toHaveText("Connected (local)");
  await page.getByTestId("ssh-host-picker").click();
  await page.getByTestId("ssh-host-option-lab").click();
  await expect(page.getByTestId("workspace-connection-status")).toHaveText("Connected (local)");
  await page.getByTestId("ssh-save").click();
  await expect(page.getByTestId("workspace-connection-status")).toHaveText("Connected (lab)");
  await page.getByTestId("ssh-test").click();
  await expect(page.getByTestId("ssh-test-result")).toBeVisible();
  await page.getByTestId("ssh-host-picker").click();
  await page.getByTestId("ssh-host-option-local").click();
  await expect(page.getByTestId("ssh-test-result")).toHaveCount(0);
  await page.getByTestId("ssh-save").click();
  await expect(page.getByTestId("workspace-connection-status")).toHaveText("Connected (local)");
  expect(restartRequests).toBe(0);
});
