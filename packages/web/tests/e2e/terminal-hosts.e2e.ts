import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "@playwright/test";
import { API_SECRET, apiGet, apiPost } from "./_helpers";
import { test } from "./_terminal-fixture";

for (const width of [1440, 390]) {
  test(`new terminal defaults to Settings SSH host at ${width}px`, async ({ page, request }) => {
    const terminal = await apiPost<{ id: string }>(request, "/terminals", {
      kind: "shell",
      host: null,
    });
    let configuredHost: string | null = "build-box";
    let launches = 0;
    await page.route("**/api/ssh", (route) =>
      route.fulfill({
        json: {
          host: configuredHost,
          hosts: ["build-box", "gpu-box"],
          supported: true,
          unsupported_reason: null,
          locked: false,
          remote_port: null,
          secret_set: true,
        },
      }),
    );
    await page.route(/\/api\/terminals(?:\?.*)?$/, async (route) => {
      const host = new URL(route.request().url()).searchParams.get("host");
      if (route.request().method() === "POST") {
        launches++;
        expect(route.request().postDataJSON()).toMatchObject({ host: "build-box", kind: "shell" });
        return route.fulfill({ status: 400, json: { error: "Captured remote launch" } });
      }
      if (host)
        return route.fulfill({
          json: {
            enabled: true,
            ready: true,
            reason: null,
            host,
            launchers: ["shell"],
            terminals: [],
          },
        });
      return route.continue();
    });
    await page.addInitScript((secret) => {
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
      localStorage.setItem("orc_terminal_cwd", "local-only-folder");
    }, API_SECRET);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/terminals/${terminal.id}?project=all`);
    await page.getByTestId("terminal-new").click();
    await expect(page.getByTestId("terminal-host-select")).toHaveValue("build-box");
    await expect(page.getByTestId("terminal-cwd")).toHaveValue("");
    await page.getByTestId("terminal-launch-shell").click();
    await expect.poll(() => launches).toBe(1);
    await page.getByTestId("terminal-host-select").selectOption("");
    await expect(page.getByTestId("terminal-cwd")).toHaveValue("local-only-folder");
    await expect(page.getByTestId("terminal-launch-shell")).toBeEnabled();
    // Reload reads the current Settings selection rather than a stale Local default.
    configuredHost = "gpu-box";
    await page.reload();
    await page.getByTestId("terminal-new").click();
    await expect(page.getByTestId("terminal-host-select")).toHaveValue("gpu-box");
    configuredHost = null;
    await page.reload();
    await page.getByTestId("terminal-new").click();
    await expect(page.getByTestId("terminal-host-select")).toHaveValue("");
    await expect(page.getByTestId("terminal-cwd")).toHaveValue("local-only-folder");
    await page.goto(`/terminals/${terminal.id}?project=all&new=1&terminalHost=gpu-box`);
    await expect(page.getByTestId("terminal-host-select")).toHaveValue("gpu-box");
    await page.getByTestId("terminal-cwd").press("Escape");
    await page.getByTestId("terminal-new").click();
    await expect(page.getByTestId("terminal-host-select")).toHaveValue("");
    expect((await apiGet<{ status: string }>(request, `/terminals/${terminal.id}`)).status).toBe(
      "running",
    );
  });
}

for (const width of [1440, 390]) {
  test(`should select a host, scope folder browsing and preserve local sessions at ${width}px`, async ({
    page,
    request,
  }) => {
    const terminal = await apiPost<{ id: string; pid: number }>(request, "/terminals", {
      kind: "shell",
      host: null,
      name: "Local workspace",
    });
    const creations: Record<string, unknown>[] = [];
    const browsed: string[] = [];
    const worktreeHosts: string[] = [];
    let globalHostWrites = 0;
    await page.route("**/api/ssh", async (route) => {
      if (route.request().method() !== "GET") globalHostWrites++;
      return route.fulfill({
        json: {
          host: null,
          hosts: ["build-box", "gpu-box"],
          supported: true,
          unsupported_reason: null,
          locked: false,
          remote_port: null,
          secret_set: true,
        },
      });
    });
    await page.route(/\/api\/terminals(?:\?.*)?$/, async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() === "POST") {
        const input = route.request().postDataJSON() as Record<string, unknown>;
        if (input.host) {
          creations.push(input);
          return route.fulfill({
            status: 400,
            json: { error: "Remote launch captured by UI fixture" },
          });
        }
      }
      if (route.request().method() === "GET" && url.searchParams.get("host")) {
        return route.fulfill({
          json: {
            enabled: true,
            ready: true,
            reason: null,
            host: url.searchParams.get("host"),
            launchers: ["shell", "codex"],
            terminals: [],
          },
        });
      }
      return route.continue();
    });
    await page.route("**/api/terminals/browse?**", async (route) => {
      const url = new URL(route.request().url());
      browsed.push(url.searchParams.get("host") ?? "");
      return route.fulfill({
        json: {
          host: url.searchParams.get("host"),
          path: "/srv/projects",
          parent: "/srv",
          directories: ["app"],
        },
      });
    });
    await page.route("**/api/git/worktrees?**", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("host")) {
        worktreeHosts.push(url.searchParams.get("host") ?? "");
        return route.fulfill({ json: { root: null, worktrees: [] } });
      }
      return route.continue();
    });
    await page.addInitScript((secret) => {
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
      localStorage.setItem("orc_terminal_cwd", "local-folder-remembered");
      localStorage.setItem("orc_terminal_worktree", "1");
    }, API_SECRET);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/terminals/${terminal.id}?project=all`);
    await expect(page.getByTestId("terminal-viewport")).toBeVisible();
    await page.getByTestId("terminal-new").click();
    await expect(page.getByTestId("terminal-cwd")).toHaveValue("local-folder-remembered");
    await page.getByTestId("terminal-host-select").selectOption("build-box");
    await expect(page.getByTestId("terminal-cwd")).toHaveValue("");
    await expect(page.getByTestId("terminal-launch-codex")).toBeEnabled();
    await page.getByTestId("terminal-browse").click();
    await expect(page.getByTestId("remote-folder-browser")).toBeVisible();
    await page.getByTestId("remote-folder-pick").click();
    await expect(page.getByTestId("terminal-cwd")).toHaveValue("/srv/projects");
    await expect.poll(() => worktreeHosts).toContain("build-box");
    mkdirSync(resolve("../../output/playwright"), { recursive: true });
    await page.screenshot({
      path: resolve(`../../output/playwright/terminal-host-selector-${width}.png`),
    });
    await page.getByTestId("terminal-launch-codex").click();
    await expect.poll(() => creations.length).toBe(1);
    expect(creations[0]).toMatchObject({
      host: "build-box",
      cwd: "/srv/projects",
      kind: "codex",
      worktree: true,
    });
    await page.getByTestId("terminal-host-select").selectOption("gpu-box");
    await expect(page.getByTestId("terminal-cwd")).toHaveValue("");
    await page.getByTestId("terminal-host-select").selectOption("build-box");
    await expect(page.getByTestId("terminal-cwd")).toHaveValue("/srv/projects");
    await expect(page.getByTestId("terminal-worktree")).toBeChecked();
    await page.getByTestId("terminal-host-select").selectOption("");
    await expect(page.getByTestId("terminal-cwd")).toHaveValue("local-folder-remembered");
    expect(browsed).toEqual(["build-box"]);
    expect(globalHostWrites).toBe(0);
    const stillRunning = await apiGet<{ pid: number; status: string; host: string | null }>(
      request,
      `/terminals/${terminal.id}`,
    );
    expect(stillRunning).toMatchObject({ pid: terminal.pid, status: "running", host: null });
    await page.getByTestId("terminal-cwd").press("Escape");
    await page.getByTestId("pane-terminal").click();
    await page.getByTestId("command-palette-input").fill("gpu-box");
    await page.locator('[data-command-id="new-terminal-host-gpu-box"]').click();
    await expect(page.getByTestId("terminal-host-select")).toHaveValue("gpu-box");
    await expect(page.getByTestId("terminal-cwd")).toHaveValue("");
    expect(creations).toHaveLength(1);
    expect(globalHostWrites).toBe(0);
  });
}

test("should explain unsupported SSH and keep Local usable", async ({ page, request }) => {
  const terminal = await apiPost<{ id: string }>(request, "/terminals", {
    kind: "shell",
    host: null,
  });
  await page.route("**/api/ssh", (route) =>
    route.fulfill({
      json: {
        host: null,
        hosts: ["build-box"],
        supported: false,
        unsupported_reason:
          "SSH execution needs OpenSSH ControlMaster support, unavailable on native Windows.",
        locked: false,
        remote_port: null,
        secret_set: true,
      },
    }),
  );
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
  await page.goto(`/terminals/${terminal.id}?project=all`);
  await page.getByTestId("terminal-new").click();
  await page.getByTestId("terminal-host-select").selectOption("build-box");
  await expect(page.getByTestId("terminal-launch-menu")).toContainText(
    "unavailable on native Windows",
  );
  await expect(page.getByTestId("terminal-browse")).toBeDisabled();
  await expect(page.getByTestId("terminal-launch-shell")).toHaveCount(0);
  await page.getByTestId("terminal-host-select").selectOption("");
  await expect(page.getByTestId("terminal-launch-shell")).toBeEnabled();
});

test("should duplicate using the original terminal host and folder", async ({ page, request }) => {
  const terminal = await apiPost<{ id: string }>(request, "/terminals", {
    kind: "shell",
    host: null,
  });
  let duplicate: Record<string, unknown> | undefined;
  await page.route("**/api/ssh", (route) =>
    route.fulfill({
      json: {
        host: null,
        hosts: ["build-box"],
        supported: true,
        unsupported_reason: null,
        locked: false,
        remote_port: null,
        secret_set: true,
      },
    }),
  );
  await page.route(/\/api\/terminals(?:\?.*)?$/, async (route) => {
    if (route.request().method() === "POST") {
      duplicate = route.request().postDataJSON() as Record<string, unknown>;
      return route.fulfill({
        status: 400,
        json: { error: "Remote duplicate captured by UI fixture" },
      });
    }
    const response = await route.fetch();
    const info = await response.json();
    info.terminals = info.terminals.map((item: { id: string }) =>
      item.id === terminal.id
        ? { ...item, host: "build-box", cwd: "/srv/app", name: "Remote workspace" }
        : item,
    );
    return route.fulfill({ response, json: info });
  });
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
  await page.goto(`/terminals/${terminal.id}?project=all`);
  await page.getByTestId("terminal-actions").click();
  await expect(page.getByTestId("terminal-duplicate")).toBeEnabled();
  await page.getByTestId("terminal-duplicate").click();
  await expect
    .poll(() => duplicate)
    .toEqual({
      kind: "shell",
      host: "build-box",
      cwd: "/srv/app",
      name: "Remote workspace (copy)",
    });
  await page.unrouteAll({ behavior: "wait" });
});
