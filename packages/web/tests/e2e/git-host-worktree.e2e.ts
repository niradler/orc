import { expect } from "@playwright/test";
import { API_SECRET, apiPost } from "./_helpers";
import { test } from "./_terminal-fixture";

test("should open a Git worktree on the selected terminal host", async ({ page, request }) => {
  const terminal = await apiPost<{ id: string }>(request, "/terminals", {
    kind: "shell",
    host: null,
  });
  let launch: unknown;
  await page.route(/\/api\/terminals(?:\?.*)?$/, async (route) => {
    if (route.request().method() === "POST") {
      launch = route.request().postDataJSON();
      return route.fulfill({
        status: 400,
        json: { error: "Remote worktree launch captured by UI fixture" },
      });
    }
    const response = await route.fetch();
    const info = await response.json();
    info.terminals = info.terminals.map((item: { id: string }) =>
      item.id === terminal.id ? { ...item, host: "build-box", cwd: "/srv/app" } : item,
    );
    return route.fulfill({ response, json: info });
  });
  await page.route("**/api/terminals/*/git/status", (route) =>
    route.fulfill({
      json: { root: "/srv/app", branch: "main", files: [], branches: ["main", "feature"] },
    }),
  );
  await page.route("**/api/terminals/*/git/worktrees", (route) =>
    route.fulfill({
      json: {
        root: "/srv/app",
        worktrees: [
          { path: "/srv/app", branch: "main", head: "a", main: true, dirty: false },
          { path: "/srv/feature", branch: "feature", head: "b", main: false, dirty: false },
        ],
      },
    }),
  );
  await page.route("**/api/terminals/*/git/github", (route) =>
    route.fulfill({ json: { auth: "none", login: null, errors: [], truncated: false, items: [] } }),
  );
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
  await page.goto(`/terminals/${terminal.id}?view=git&project=all`);
  await page.getByTestId("git-checkout-toggle").click();
  await page.getByTestId("git-worktree-select").selectOption("/srv/feature");
  await expect
    .poll(() => launch)
    .toEqual({ kind: "shell", cwd: "/srv/feature", host: "build-box" });
  await expect(page.getByTestId("terminal-git-panel").getByRole("alert")).toContainText("captured");
  await page.unrouteAll({ behavior: "wait" });
});
