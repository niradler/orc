import { expect, test } from "@playwright/test";
import { apiPost, gotoView, tid } from "./_helpers";

for (const viewport of [
  { width: 320, height: 650 },
  { width: 390, height: 700 },
  { width: 1440, height: 800 },
]) {
  test(`package setup keeps launch actions visible while editing at ${viewport.width}px`, async ({
    page,
  }, testInfo) => {
    const pkg = {
      name: "layout-review-package",
      version: "1.0.0",
      description: "Reusable professional workflow. ".repeat(12),
      path: "/fixture/package",
      manifest: { name: "layout-review-package" },
      format: "agent-plugin",
      manifestFile: "plugin.json",
      warnings: [],
      content: "{}",
      files: Array.from({ length: 20 }, (_, i) => ({
        name: `skills/workflow-${i}/SKILL.md`,
        path: `/fixture/${i}`,
      })),
    };
    await page.route("**/api/agent-packages", (route) =>
      route.fulfill({ json: { packages: [pkg], broken: [] } }),
    );
    await page.route("**/api/agent-packages/layout-review-package", (route) =>
      route.fulfill({ json: pkg }),
    );
    await page.route("**/api/ssh", (route) => route.fulfill({ json: { host: null, hosts: [] } }));
    await page.route("**/api/package-tools**", (route) =>
      route.fulfill({ json: { apm: true, skills: true, bun: true } }),
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
    const operations: { url: string; body: Record<string, unknown> }[] = [];
    await page.route("**/api/agent-setups/command", async (route) => {
      operations.push({ url: route.request().url(), body: route.request().postDataJSON() });
      await route.fulfill({ json: { command: "echo review-package", shell: "bash", notice: "" } });
    });
    await page.route("**/api/terminals", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      operations.push({ url: route.request().url(), body: route.request().postDataJSON() });
      await route.fulfill({ status: 400, json: { error: "Install fixture rejected" } });
    });
    await page.route("**/api/chat/threads", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      operations.push({ url: route.request().url(), body: route.request().postDataJSON() });
      await route.fulfill({ status: 400, json: { error: "Unexpected chat execution" } });
    });
    await page.setViewportSize(viewport);
    await gotoView(page, "packages");
    await page
      .locator('[data-testid="agent-package-row"][data-package-name="layout-review-package"]')
      .getByTestId("package-run")
      .click();
    await expect(page.getByTestId("setup-components")).toContainText("20 skill files");
    await page.getByTestId("setup-backend").selectOption("codex");
    await page.getByTestId("setup-cwd").fill("/fixture/work");
    const action = page.getByTestId("setup-destination");
    await expect(action).toHaveValue("terminal");
    expect(
      await action
        .locator("option")
        .evaluateAll((options) => options.map((option) => option.value)),
    ).toEqual(["terminal", "chat", "command"]);
    await page.getByTestId("setup-instructions-tab").click();
    await page
      .getByTestId("setup-prompt")
      .fill("Review and explain the workflow without running it.");
    await page.getByTestId("setup-context-tab").click();
    await expect(page.getByTestId("setup-cwd")).toHaveValue("/fixture/work");
    await page.getByTestId("setup-instructions-tab").click();
    await expect(page.getByTestId("setup-prompt")).toHaveValue(
      "Review and explain the workflow without running it.",
    );
    await action.selectOption("chat");
    await action.selectOption("command");
    expect(operations).toEqual([]);
    await page.getByTestId("setup-command").click();
    await expect(page.getByTestId("package-command")).toHaveValue("echo review-package");
    expect(operations).toHaveLength(1);
    await page.getByTestId("setup-context-tab").click();
    await page.getByTestId("setup-instructions-tab").click();
    await expect(page.getByTestId("package-command")).toHaveValue("echo review-package");
    await action.selectOption("chat");
    await page.getByTestId("setup-context-tab").click();
    await page.getByTestId("setup-backend").selectOption("copilot");
    await expect(action.locator('option[value="chat"]')).toBeDisabled();
    await expect(action.locator('option[value="chat"]')).toContainText("requires Claude or Codex");
    await expect(page.getByTestId("setup-launch")).toBeDisabled();
    await expect(page.getByRole("alert")).toContainText("Chat requires Claude or Codex");
    await action.selectOption("terminal");
    await page.getByTestId("setup-backend").selectOption("codex");
    await page.getByTestId("setup-install-info").click();
    await expect(page.getByTestId("setup-install-explanation")).toContainText(
      "without launching an agent",
    );
    expect(operations).toHaveLength(1);
    await page.getByTestId("setup-install").click();
    await expect.poll(() => operations.length).toBe(2);
    expect(operations[1]?.body).toMatchObject({
      setup: {
        operation: "install",
        cwd: "/fixture/work",
        prompt: "Review and explain the workflow without running it.",
      },
    });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("setup-error")).toContainText("Install fixture rejected");
    const dialog = page.getByRole("dialog");
    const launch = page.getByTestId("setup-launch");
    await expect(launch).toBeEnabled();
    const box = await launch.boundingBox();
    console.log(JSON.stringify({ viewport, dialog: await dialog.boundingBox(), launch: box }));
    await page.screenshot({ path: testInfo.outputPath(`package-setup-${viewport.width}.png`) });
    if (!box) throw new Error("Missing launch action");
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    for (const control of [action, page.getByTestId("setup-install-info")]) {
      const bounds = await control.boundingBox();
      expect(bounds).toBeTruthy();
      if (!bounds) throw new Error("Missing footer control");
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
      if (viewport.width < 640) expect(bounds.height).toBeGreaterThanOrEqual(44);
    }
  });
}

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
  const originalFolder = await page.getByTestId("setup-cwd").inputValue();
  await page.getByTestId("setup-browse").click();
  await expect(page.getByTestId("folder-picker-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("folder-picker-dialog")).toBeHidden();
  await expect(page.getByTestId("setup-cwd")).toHaveValue(originalFolder);
  await expect(page.getByTestId("setup-browse")).toBeFocused();
  await page.getByTestId("setup-browse").click();
  await page.getByTestId("remote-folder-cancel").click();
  await expect(page.getByTestId("setup-cwd")).toHaveValue(originalFolder);
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
