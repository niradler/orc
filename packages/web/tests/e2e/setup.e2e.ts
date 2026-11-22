import { expect, type Page, test } from "@playwright/test";
import { gotoView } from "./_helpers";

/**
 * First-run setup (issue #451). The screen must reflect a fresh workspace, so
 * these tests mock the detection endpoint and the project list instead of
 * depending on which agents the test host happens to have, and they mock
 * /settings so a dismissal never writes to the real user config.
 */

const agents = [
  {
    agent: "claude",
    label: "Claude Code",
    installed: true,
    path: "/bin/claude",
    version: "2.0.15",
    signed_in: true,
    account_label: "claude@example.com",
    fix: null,
  },
  {
    agent: "codex",
    label: "Codex",
    installed: true,
    path: "/bin/codex",
    version: "0.45.0",
    signed_in: false,
    account_label: null,
    fix: { label: "Sign in to Codex", command: "codex login" },
  },
  {
    agent: "opencode",
    label: "OpenCode",
    installed: true,
    path: "/bin/opencode",
    version: "0.16.0",
    signed_in: true,
    account_label: null,
    fix: null,
  },
  {
    agent: "pi",
    label: "Pi",
    installed: false,
    path: null,
    version: null,
    signed_in: null,
    account_label: null,
    fix: { label: "Install Pi", command: "npm i -g @earendil-works/pi-coding-agent" },
  },
  {
    agent: "cursor",
    label: "Cursor",
    installed: false,
    path: null,
    version: null,
    signed_in: null,
    account_label: null,
    fix: { label: "Install Cursor", command: "curl https://cursor.com/install -fsS | bash" },
  },
];

const suggestions = [
  {
    path: "C:/dev/orc",
    name: "orc",
    agents: ["claude", "codex"],
    sessions: 12,
    last_activity_at: new Date(Date.now() - 3_600_000).toISOString(),
  },
  {
    path: "C:/dev/blog",
    name: "blog",
    agents: ["opencode"],
    sessions: 3,
    last_activity_at: new Date(Date.now() - 86_400_000).toISOString(),
  },
];

/** Fresh-install world: no projects, default preferences, fixed detection. */
async function mockFreshWorkspace(page: Page): Promise<void> {
  await page.route("**/api/setup", (route) =>
    route.fulfill({ json: { agents, suggestions, default_agent: "claude" } }),
  );
  await page.route("**/api/projects*", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { projects: [], offset: 0, limit: 100, next_offset: null } })
      : route.continue(),
  );
  await page.route("**/api/settings", (route) =>
    route.request().method() === "GET" ? route.fulfill({ json: {} }) : route.continue(),
  );
  // Provider profiles decide which agents can become the default; keep the
  // enabled set fixed instead of depending on the test host's binaries.
  await page.route("**/api/settings/providers", (route) => {
    const method = route.request().method();
    if (method === "PUT") return route.fulfill({ json: route.request().postDataJSON() ?? {} });
    if (method !== "GET") return route.continue();
    const profile = (agent: string, enabled: boolean) => ({
      id: agent,
      name: agent,
      agent,
      enabled,
      executable: "",
      model: "",
      environment: [],
    });
    return route.fulfill({
      json: {
        providers: [
          profile("claude", true),
          profile("codex", true),
          profile("opencode", true),
          profile("pi", false),
          profile("cursor", true),
        ],
        default_provider_id: "claude",
        revision: "fixture",
      },
    });
  });
}

test.describe("first-run setup", () => {
  test("lists detected agents with status and suggests projects from their history", async ({
    page,
  }) => {
    await mockFreshWorkspace(page);
    await gotoView(page, "activity");
    const setup = page.getByTestId("first-run-setup");
    await expect(setup).toBeVisible();

    // Done-when: every agent appears with installed / signed-in / version status.
    await expect(page.getByTestId("first-run-agent-claude")).toBeVisible();
    await expect(page.getByTestId("first-run-agent-status-claude")).toContainText("Installed");
    await expect(page.getByTestId("first-run-agent-status-claude")).toContainText(
      "Signed in as claude@example.com",
    );
    await expect(page.getByTestId("first-run-agent-status-claude")).toContainText("v2.0.15");
    await expect(page.getByTestId("first-run-agent-status-codex")).toContainText("Not signed in");
    await expect(page.getByTestId("first-run-agent-status-opencode")).toContainText("Signed in");
    await expect(page.getByTestId("first-run-agent-status-pi")).toContainText("Not installed");
    await expect(page.getByTestId("first-run-agents-ready")).toHaveText("2 of 5 ready");

    // The fix action reveals the exact command for a signed-out agent.
    await page.getByTestId("first-run-fix-codex").click();
    await expect(page.getByTestId("first-run-fix-command-codex")).toHaveText("codex login");
    await expect(page.getByTestId("first-run-fix-pi")).toBeVisible();

    // Default agent is marked; a ready non-default agent can become the default.
    await expect(page.getByTestId("first-run-default-claude")).toHaveText("Default");
    await expect(page.getByTestId("first-run-default-opencode")).toHaveText("Make default");
    const saved = page.waitForRequest(
      (request) => request.url().endsWith("/api/settings/providers") && request.method() === "PUT",
    );
    await page.getByTestId("first-run-default-opencode").click();
    expect((await saved).postDataJSON()).toMatchObject({ default_provider_id: "opencode" });

    // Done-when: the folders from agent history are suggested with their context.
    await expect(page.getByTestId("first-run-suggestion-0")).toContainText("orc");
    await expect(page.getByTestId("first-run-suggestion-0")).toContainText("C:/dev/orc");
    await expect(page.getByTestId("first-run-suggestion-0")).toContainText("12 sessions");
    await expect(page.getByTestId("first-run-suggestion-1")).toContainText("blog");
    await expect(page.getByTestId("first-run-phone-link")).toBeVisible();
  });

  test("one click creates the selected suggested projects", async ({ page }) => {
    await mockFreshWorkspace(page);
    const created: unknown[] = [];
    await page.route("**/api/projects", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const body = route.request().postDataJSON();
      created.push(body);
      await route.fulfill({
        status: 201,
        json: { id: `p-${created.length}`, ...(body as object), status: "active" },
      });
    });
    await gotoView(page, "activity");
    await expect(page.getByTestId("first-run-setup")).toBeVisible();

    // Uncheck one suggestion: only the checked one is created.
    await page.getByTestId("first-run-suggestion-check-1").uncheck();
    await expect(page.getByTestId("first-run-create")).toHaveText("Create 1 project");
    await page.getByTestId("first-run-create").click();

    await expect(page.getByTestId("first-run-suggestion-created-0")).toBeVisible();
    expect(created).toEqual([{ name: "orc", scope: "C:/dev/orc" }]);
  });

  test("a failed create keeps its row selected and reports the error", async ({ page }) => {
    await mockFreshWorkspace(page);
    await page.route("**/api/projects", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 409, json: { error: "Project already exists" } })
        : route.continue(),
    );
    await gotoView(page, "activity");
    await page.getByTestId("first-run-suggestion-check-1").uncheck();
    await page.getByTestId("first-run-create").click();
    await expect(page.getByTestId("first-run-suggestion-error-0")).toContainText(
      "Project already exists",
    );
    await expect(page.getByTestId("first-run-suggestion-check-0")).toBeChecked();
  });

  test("dismiss hides the screen and persists across reloads", async ({ page }) => {
    await mockFreshWorkspace(page);
    let dismissed = false;
    await page.unroute("**/api/settings");
    await page.route("**/api/settings", (route) => {
      if (route.request().method() === "PATCH") {
        expect(route.request().postDataJSON()).toMatchObject({ setup_dismissed: true });
        dismissed = true;
        return route.fulfill({ json: { setup_dismissed: true } });
      }
      return route.fulfill({ json: dismissed ? { setup_dismissed: true } : {} });
    });
    await gotoView(page, "activity");
    await expect(page.getByTestId("first-run-setup")).toBeVisible();
    await page.getByTestId("first-run-dismiss").click();
    await expect(page.getByTestId("first-run-setup")).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("first-run-setup")).toHaveCount(0);
    await expect(page.getByTestId("activity-preview")).toBeVisible();
  });
});
