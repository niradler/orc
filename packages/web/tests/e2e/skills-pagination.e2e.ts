import { expect, test } from "@playwright/test";
import { API_BASE, AUTH_HEADERS, apiGet, apiPost, gotoView, tid } from "./_helpers";

test("skills paginate and searching resets the page while preserving relevance", async ({
  page,
  request,
}) => {
  const prefix = tid("pagination");
  const project = await apiPost<{ id: string }>(request, "/projects", { name: prefix });
  for (let i = 0; i < 35; i++) {
    const name = `${prefix}-${String(i).padStart(2, "0")}`;
    await apiPost(request, "/skills", {
      name,
      content: `---\nname: ${name}\ndescription: Pagination fixture ${i}\n---\nInstructions.`,
    });
    const assignment = await request.put(`${API_BASE}/skills/${name}/projects`, {
      headers: AUTH_HEADERS,
      data: { project_ids: [project.id] },
    });
    expect(assignment.ok()).toBe(true);
  }
  await gotoView(page, "skills");
  await page.goto(`/skills?project=${project.id}`);
  await page.getByTestId("skill-search-input").fill(prefix);

  await expect(page.getByTestId("skill-row")).toHaveCount(30);
  await expect(page.getByTestId("skills-page-summary")).toHaveText("1–30 of 35");
  await page.getByTestId("skills-next").click();
  await expect(page.getByTestId("skill-row")).toHaveCount(5);
  await expect(page.getByTestId("skills-page-summary")).toHaveText("31–35 of 35");
  await expect(page.getByTestId("skills-next")).toBeDisabled();
  await page.getByTestId("skills-previous").click();
  await expect(page.getByTestId("skill-row")).toHaveCount(30);
  await page.getByTestId("skills-next").click();
  await page.getByTestId("skill-search-input").fill(`${prefix}-00`);

  await expect(page.getByTestId("skill-row")).toHaveCount(1);
  await expect(page.getByTestId("skill-row")).toContainText(`${prefix}-00`);
  const ranked = await apiGet<{ skills: { name: string; score: number }[]; total: number }>(
    request,
    `/skills?q=${encodeURIComponent(prefix)}&project_id=${project.id}&limit=1`,
  );
  expect(ranked.total).toBe(35);
  expect(ranked.skills[0]?.score).toBeGreaterThan(0);
});
