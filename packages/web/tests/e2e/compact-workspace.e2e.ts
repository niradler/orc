import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { apiPost, gotoView, repoRoot, tid } from "./_helpers";

test("view help works with keyboard, hover and touch without permanent introductions", async ({
  page,
  browser,
}) => {
  await gotoView(page, "sessions");
  await expect(page.getByTestId("archive-disclosure")).not.toHaveAttribute("open");
  const help = page.getByTestId("live-sessions").getByTestId("view-help");
  await help.focus();
  await expect(page.getByTestId("view-help-content")).toBeVisible();
  await expect(page.getByTestId("view-help-content")).toContainText(
    "Discovered from your coding agents",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("view-help-content")).toHaveCount(0);
  await help.hover();
  await expect(page.getByTestId("view-help-content")).toBeVisible();
  await page.mouse.move(0, 0);
  await help.blur();
  await expect(page.getByTestId("view-help-content")).toHaveCount(0);

  const phoneContext = await browser.newContext({
    hasTouch: true,
    viewport: { width: 320, height: 844 },
    baseURL: new URL(page.url()).origin,
  });
  try {
    const phone = await phoneContext.newPage();
    await gotoView(phone, "scratchpads");
    await phone.getByTestId("view-help").tap();
    await expect(phone.getByTestId("view-help-content")).toBeVisible();
    const bounds = await phone.getByTestId("view-help-content").boundingBox();
    if (!bounds) throw new Error("Help content has no visible bounds");
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
    await phone.getByTestId("view-help").tap();
    await expect(phone.getByTestId("view-help-content")).toHaveCount(0);
    await phone.getByTestId("view-help").tap();
    await expect(phone.getByTestId("view-help-content")).toBeVisible();
    await phone.getByTestId("view-title").tap();
    await expect(phone.getByTestId("view-help-content")).toHaveCount(0);
  } finally {
    await phoneContext.close();
  }
});

test("phone filters retain URL state and survive hide, resize and reload", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoView(page, "sessions");
  await expect(page.getByTestId("view-filters")).toBeHidden();
  const toggle = page.getByTestId("view-filters-toggle");
  await toggle.click();
  await page.getByTestId("agent-filter").selectOption("codex");
  await page.getByTestId("session-date-sort").selectOption("asc");
  await page.getByTestId("show-ended").click();
  await expect(page.getByTestId("show-ended")).not.toBeChecked();
  await expect(toggle).toHaveText("Filters (3)");
  await toggle.click();
  await expect(page.getByTestId("view-filters")).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId("agent-filter")).toBeVisible();
  await expect(page.getByTestId("agent-filter")).toHaveValue("codex");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("view-filters")).toBeHidden();
  await page.reload();
  await page.getByTestId("view-filters-toggle").click();
  await expect(page.getByTestId("session-date-sort")).toHaveValue("asc");
  await expect(page.getByTestId("show-ended")).not.toBeChecked();
});

test("scratchpad search applies without a button and retains kind and project filters", async ({
  page,
  request,
}) => {
  const project = await apiPost<{ id: string }>(request, "/projects", {
    name: tid("compact-pads"),
  });
  const title = tid("Working plan");
  const pad = await apiPost<{ id: string }>(request, "/scratchpads", {
    title,
    kind: "doc",
    project_id: project.id,
    content: "A compact workspace",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoView(page, "scratchpads");
  await page.getByTestId("scratchpad-search-input").fill(title);
  const row = page.locator(`[data-testid="scratchpad-row"][data-scratchpad-id="${pad.id}"]`);
  await expect(row).toBeVisible();
  await expect(page).toHaveURL(/padQuery=/);
  await page.getByTestId("view-filters-toggle").click();
  await page.getByTestId("scratchpad-kind-doc").click();
  await page.getByTestId("scratchpad-project-filter").click();
  await page.getByTestId(`scratchpad-project-${project.id}`).click();
  await page.getByTestId("view-filters-toggle").click();
  await page.reload();
  await expect(row).toBeVisible();
  await expect(page.getByTestId("scratchpad-search-input")).toHaveValue(title);
  await row.click();
  await expect(page.getByTestId("scratchpad-title")).toHaveText(title);
});

test("job filters reset selection and restrict bulk changes to visible jobs", async ({
  page,
  request,
}) => {
  const project = await apiPost<{ id: string }>(request, "/projects", {
    name: tid("compact-jobs"),
  });
  const names = [tid("Daily audit"), tid("Manual review")] as const;
  for (const name of names)
    await apiPost(request, "/jobs", {
      name,
      command: "echo compact-ui",
      trigger_type: "manual",
      project_id: project.id,
      enabled: false,
    });
  await gotoView(page, "jobs");
  await page.goto(`/jobs?project=${project.id}`);
  await expect(page.getByTestId("job-row")).toHaveCount(2);
  await page.getByTestId("job-select").first().check();
  await page.getByTestId("job-search").fill(names[1]);
  await expect(page.getByTestId("job-row")).toHaveCount(1);
  await expect(page.getByTestId("job-select")).not.toBeChecked();
  await page.getByTestId("job-select").check();
  await page.getByTestId("jobs-bulk-enable").click();
  await expect(page.getByTestId("jobs-bulk-result")).toContainText("1 jobs enabled");
  await page.getByTestId("job-search").clear();
  await page.getByTestId("job-status-filter").selectOption("disabled");
  await expect(page.getByTestId("job-row")).toHaveCount(1);
  await expect(page.getByTestId("job-row")).toContainText(names[0]);
});

test("populated workspaces fit desktop, tablet and phones in both themes", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const project = await apiPost<{ id: string }>(request, "/projects", {
    name: tid("visual-workspace"),
  });
  for (const [kind, title] of [
    ["doc", "Release checklist"],
    ["html", "UI cleanup proposal"],
    ["diagram", "Access provider flow"],
  ]) {
    await apiPost(request, "/scratchpads", { title, kind, project_id: project.id });
  }
  await apiPost(request, "/jobs", {
    name: "Knowledge digest",
    command: "echo preview",
    trigger_type: "manual",
    project_id: project.id,
    enabled: false,
  });
  await page.route("**/api/sessions/live?*", (route) =>
    route.fulfill({
      json: {
        sessions: [
          {
            id: "compact-session",
            session_id: "compact-native",
            agent: "codex",
            name: "Workspace UI cleanup",
            status: "stopped",
            project_id: project.id,
            task: null,
            handoff: null,
            last_activity_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
            tokens_used: 48200,
            tokens_estimated: false,
            cwd: "C:/Projects/orc",
            summary: "Reduce repeated introductions and make room for active work.",
          },
        ],
      },
    }),
  );
  await gotoView(page, "sessions");
  const output = join(repoRoot(), ".claude/validation/ux-density");
  mkdirSync(output, { recursive: true });
  for (const theme of ["dark", "light"]) {
    await page.evaluate((theme) => {
      localStorage.setItem("orc_theme", theme);
      document.documentElement.classList.toggle("dark", theme === "dark");
    }, theme);
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const route of ["webhooks", "sessions", "scratchpad", "jobs"]) {
        await page.goto(
          `/${route}?project=${project.id}${route === "scratchpad" ? `&padProject=${project.id}` : ""}`,
        );
        if (route === "sessions") await expect(page.getByTestId("live-session-row")).toBeVisible();
        if (route === "scratchpad") await expect(page.getByTestId("scratchpad-row")).toHaveCount(3);
        if (route === "jobs") await expect(page.getByTestId("job-row")).toHaveCount(1);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `${theme} ${width} ${route}`,
        ).toBe(true);
        await page.screenshot({ path: join(output, `${route}-${theme}-${width}.png`) });
      }
    }
  }
});
