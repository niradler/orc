import { expect, test } from "@playwright/test";
import { API_SECRET } from "./_helpers";

test("Unassigned never opens or requests the all-project GitHub feed", async ({ page }) => {
  await page.addInitScript(
    (secret) =>
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret),
    API_SECRET,
  );
  await page.route("**/api/projects?**", (route) =>
    route.fulfill({
      json: {
        projects: [
          {
            id: "fixture-project",
            name: "Scoped project",
            status: "active",
            repo_url: "https://github.com/fixture/scoped",
            cwd: "/fixture",
          },
        ],
      },
    }),
  );
  const scopes: Array<string | null> = [];
  await page.route("**/api/github/items?**", (route) => {
    scopes.push(new URL(route.request().url()).searchParams.get("project_id"));
    return route.fulfill({
      json: { auth: "gh", login: "fixture", errors: [], truncated: false, items: [] },
    });
  });
  await page.goto("/tasks?project=all");
  await page.getByTestId("github-board-toggle").click();
  await expect(page.getByTestId("github-board")).toBeVisible();
  await expect.poll(() => scopes).toEqual([null]);
  const picker = page.getByTestId("sidebar-project-select").filter({ visible: true });
  await picker.click();
  await page.getByTestId("project-option-unassigned").click();
  await expect(page).toHaveURL(/project=unassigned/);
  await expect(page.getByTestId("github-board-toggle")).toHaveCount(0);
  await expect(page.getByTestId("github-board")).toHaveCount(0);
  expect(scopes).toEqual([null]);
  await page.reload();
  await expect(page.getByTestId("view-title")).toHaveText("Tasks");
  await expect(page.getByTestId("github-board-toggle")).toHaveCount(0);
  expect(scopes).toEqual([null]);
  await picker.click();
  await page.getByTestId("project-option-fixture-project").click();
  await expect(page).toHaveURL(/project=fixture-project/);
  await page.getByTestId("github-board-toggle").click();
  await expect(page.getByTestId("github-board")).toBeVisible();
  await expect.poll(() => scopes).toEqual([null, "fixture-project"]);
});
