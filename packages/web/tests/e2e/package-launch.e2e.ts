import { expect, test } from "@playwright/test";
import { apiPost, gotoView, tid } from "./_helpers";

test("Use package selects Codex, browses SSH, and opens chat on the selected host", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const name = tid("launch-plugin");
  await apiPost(request, "/agent-packages", {
    name,
    format: "agent-plugin",
    content: JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name,
    }),
    files: [
      {
        path: "skills/example/SKILL.md",
        content: "---\nname: example\ndescription: Example workflow\n---\nUse evidence.",
      },
    ],
  });
  await page.route("**/api/ssh", (route) =>
    route.fulfill({ json: { host: null, hosts: ["test-ssh"] } }),
  );
  await page.route("**/api/package-tools**", (route) =>
    route.fulfill({ json: { apm: false, skills: false, bun: true } }),
  );
  await page.route("**/api/terminals?**", (route) =>
    route.fulfill({
      json: {
        terminals: [],
        ready: true,
        reason: null,
        launchers: ["codex"],
        host: new URL(route.request().url()).searchParams.get("host") || null,
      },
    }),
  );
  await page.route("**/api/terminals/browse?**", async (route) => {
    expect(new URL(route.request().url()).searchParams.get("host")).toBe("test-ssh");
    await route.fulfill({
      json: { host: "test-ssh", path: "/srv/free-folder", parent: "/srv", directories: [] },
    });
  });
  let setup: Record<string, unknown> | undefined;
  const threadId = crypto.randomUUID();
  await page.route("**/api/chat/threads", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    setup = route.request().postDataJSON().setup;
    await route.fulfill({
      json: {
        id: threadId,
        title: "Package chat",
        config: {
          agent: "codex",
          model: "",
          models: [],
          system: "",
          autoApprove: false,
          agentOptions: {},
          mcp: "native",
        },
        cwd: "/srv/free-folder",
        host: "test-ssh",
        runtimeId: null,
        backend: "codex-cli",
        sourceId: null,
        messages: [],
        updatedAt: Date.now(),
      },
    });
  });
  await gotoView(page, "packages");
  await page
    .locator(`[data-testid="agent-package-row"][data-package-name="${name}"]`)
    .getByTestId("package-run")
    .click();
  await page.getByTestId("setup-backend").selectOption("codex");
  await page.getByTestId("setup-host").selectOption("test-ssh");
  await page.getByTestId("setup-browse").click();
  await page.getByTestId("remote-folder-pick").click();
  await expect(page.getByTestId("setup-cwd")).toHaveValue("/srv/free-folder");
  await page.getByTestId("setup-destination").selectOption("chat");
  await expect(page.getByTestId("setup-launch")).toBeEnabled();
  const dialog = page.getByRole("dialog");
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: "../../output/playwright/package-launch-mobile.png" });
  await page.getByTestId("setup-launch").click();
  await expect
    .poll(() => setup)
    .toMatchObject({
      backend: "codex",
      packages: [name],
      host: "test-ssh",
      cwd: "/srv/free-folder",
    });
  await expect(page).toHaveURL(new RegExp(`chatThread=${threadId}`));
});

test("saved agent definitions expose the same host and destination choices", async ({
  page,
  request,
}) => {
  const id = tid("launch-agent");
  await page.route("**/api/ssh", (route) => route.fulfill({ json: { host: null, hosts: [] } }));
  await page.route("**/api/package-tools**", (route) =>
    route.fulfill({ json: { apm: false, skills: false, bun: true } }),
  );
  await page.route("**/api/terminals?**", (route) =>
    route.fulfill({
      json: {
        terminals: [],
        ready: true,
        reason: null,
        launchers: ["codex", "claude"],
        host: null,
      },
    }),
  );
  await apiPost(request, "/agents", {
    id,
    content: "---\nname: Launch example\ndescription: Use a saved agent\n---\nCheck evidence.",
  });
  await gotoView(page, "packages");
  await page.goto("/packages/agents?project=all");
  await page.locator(`[data-testid="agent-row"][data-agent-id="${id}"]`).click();
  await page.getByTestId("agent-launch").click();
  await expect(page.getByTestId("setup-host")).toBeVisible();
  await page.getByTestId("setup-destination").selectOption("chat");
  await expect(page.getByTestId("setup-cwd")).toHaveValue("");
  await page.getByTestId("setup-cwd").fill("/any/folder");
  await page.getByTestId("setup-backend").selectOption("claude");
  await expect(page.getByTestId("setup-launch")).toBeEnabled();
});
