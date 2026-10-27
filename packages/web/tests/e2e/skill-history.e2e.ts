import { expect, test } from "@playwright/test";
import { gotoView } from "./_helpers";

test("skill history shows dated changes and can reveal full versions", async ({ page }) => {
  await page.route("**/api/skills/orc-sdlc/history**", (route) =>
    route.fulfill({
      json: {
        changes: [
          {
            id: "history-test",
            action: "skill.updated",
            reason: "Update instructions",
            author: "Codex",
            created_at: 1700000000,
            previous_raw: "Unchanged heading\nOld instruction\n",
            raw: "Unchanged heading\nNew instruction\n",
          },
        ],
      },
    }),
  );
  await gotoView(page, "skills");
  await page
    .locator('[data-testid="skill-row"][data-skill-name="orc-sdlc"]')
    .getByTestId("skill-open")
    .click();
  const revision = page.getByTestId("skill-history-change");
  await expect(revision.locator("time")).toHaveAttribute("datetime", "2023-11-14T22:13:20.000Z");
  await revision.locator("summary").click();
  await expect(revision.getByTestId("skill-change-diff")).toContainText("- Old instruction");
  await expect(revision.getByTestId("skill-change-diff")).toContainText("+ New instruction");
  await expect(revision.getByTestId("skill-change-diff")).not.toContainText("Unchanged heading");
  await expect(revision.getByTestId("skill-change-full")).toHaveCount(0);
  await revision.getByRole("button", { name: "Show full skill" }).click();
  await expect(revision.getByTestId("skill-change-full")).toContainText("Unchanged heading");
  await revision.getByRole("button", { name: "Hide full skill" }).click();
  await expect(revision.getByTestId("skill-change-full")).toHaveCount(0);
});
