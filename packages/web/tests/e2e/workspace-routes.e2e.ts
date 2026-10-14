import { expect, test } from "@playwright/test";
import { apiPost, gotoView, selectProject, tid } from "./_helpers";

test("shared project URLs align the shell and page without replacing the saved preference", async ({
  page,
  request,
}) => {
  const project = await apiPost<{ id: string; name: string }>(request, "/projects", {
    name: tid("shared-workspace"),
  });
  await gotoView(page, "tasks");
  await page.goto(`/tasks?project=${project.id}&view=table&status=todo`);
  await expect(page.getByTestId("sidebar-project-select")).toHaveAttribute(
    "data-project-id",
    project.id,
  );
  await expect(page.getByRole("banner")).toContainText(project.name);
  expect(await page.evaluate(() => localStorage.getItem("orc_selected_project"))).toBe("all");
  await selectProject(page, "unassigned");
  await expect(page).toHaveURL(/project=unassigned/);
  expect(new URL(page.url()).searchParams.get("view")).toBe("table");
  await page.goBack();
  await expect(page.getByTestId("sidebar-project-select")).toHaveAttribute(
    "data-project-id",
    project.id,
  );
  await page.getByTestId("nav-knowledge").click();
  await expect(page).toHaveURL(new RegExp(`/knowledge/wiki\\?project=${project.id}`));
  await page.getByTestId("section-knowledge").click();
  await expect(page).toHaveURL(new RegExp(`/knowledge/base\\?project=${project.id}`));
  await page.getByTestId("nav-wiki").click();
  await expect(page).toHaveURL(new RegExp(`/knowledge/wiki\\?project=${project.id}`));
  await expect(page.getByTestId("view-title")).toHaveText("Wiki");
  await page.reload();
  await expect(page.getByRole("banner")).toContainText(project.name);
});

test("Wiki document modes restore from shared URLs and browser history", async ({
  page,
  request,
}) => {
  const slug = tid("shared-note");
  await apiPost(request, "/wiki", {
    project_id: null,
    slug,
    title: "Shareable document",
    kind: "concept",
    summary: "Document route fixture",
    content: "# Shareable document\n\nCommitted content.",
    expected_revision: 0,
    note: "Validation fixture",
  });
  await gotoView(page, "wiki");
  await page.goto(`/wiki?page=${slug}&project=all&editorMode=split`);
  await expect(page.getByTestId("markdown-mode-split")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("markdown-mode-edit").click();
  expect(new URL(page.url()).searchParams.get("page")).toBe(slug);
  expect(new URL(page.url()).searchParams.get("editorMode")).toBe("edit");
  await page.goBack();
  await expect(page.getByTestId("markdown-mode-split")).toHaveAttribute("aria-pressed", "true");
  await page.goForward();
  await expect(page.getByTestId("markdown-mode-edit")).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(page.getByTestId("markdown-mode-edit")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("markdown-mode-read").click();
  await expect(page.getByTestId("markdown-preview")).toContainText("Committed content.");
});

test("Chat is generic and its open view restores from the URL across breakpoints", async ({
  page,
}) => {
  await gotoView(page, "tasks");
  await expect(page.getByTestId("chat-open-button")).toContainText("Chat");
  await page.getByTestId("chat-open-button").click();
  expect(new URL(page.url()).searchParams.get("chat")).toBe("open");
  await expect(page.getByTestId("chat-panel")).toBeVisible();
  await page.getByTestId("nav-activity").click();
  await expect(page).toHaveURL(/\/activity\?/);
  expect(new URL(page.url()).searchParams.get("chat")).toBe("open");
  await expect(page.getByTestId("chat-panel")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("chat-panel")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("mobile-chat-sheet")).toBeVisible();
  await page.getByRole("button", { name: "Close chat", exact: true }).click();
  await expect(page.getByTestId("mobile-chat-sheet")).not.toBeVisible();
  await expect(page.getByTestId("chat-open-button")).toBeFocused();
  expect(new URL(page.url()).searchParams.has("chat")).toBe(false);
  await page.goBack();
  await expect(page.getByTestId("mobile-chat-sheet")).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId("mobile-chat-sheet")).not.toBeVisible();
  await expect(page.getByTestId("chat-panel")).toBeVisible();
});

test("root and legacy Activity links preserve shared state and mobile navigation returns focus", async ({
  page,
}) => {
  await gotoView(page, "tasks");
  await page.goto("/?project=unassigned&chat=open#shared-view");
  await expect(page.getByTestId("chat-panel")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/activity");
  expect(new URL(page.url()).searchParams.get("project")).toBe("unassigned");
  expect(new URL(page.url()).hash).toBe("#shared-view");
  await expect(
    page.getByTestId("workspace-sidebar").locator("nav > button").first(),
  ).toHaveAttribute("data-testid", "nav-activity");
  await page.goto("/overview?project=unassigned#shared-view");
  await expect(page).toHaveURL(/\/activity\?/);
  await page.goto("/dashboard?project=unassigned#shared-view");
  await expect(page.getByTestId("view-title")).toHaveText("Activity");
  expect(new URL(page.url()).pathname).toBe("/activity");
  expect(new URL(page.url()).searchParams.get("project")).toBe("unassigned");
  expect(new URL(page.url()).hash).toBe("#shared-view");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("mobile-nav-open").click();
  await expect(page.getByTestId("mobile-nav-drawer")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("mobile-nav-drawer")).not.toBeVisible();
  await expect(page.getByTestId("mobile-nav-open")).toBeFocused();
});
