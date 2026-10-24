import { expect, test } from "@playwright/test";
import { API_BASE, AUTH_HEADERS, apiGet, apiPost, gotoView, tid } from "./_helpers";

test("built-in visibility saves, reopens, and preserves user skills and named reads", async ({
  page,
  request,
  browser,
}) => {
  const original = await apiGet<{ hidden_builtins: string[] }>(
    request,
    "/skills/settings/visibility",
  );
  const name = tid("pw-visible-user");
  await apiPost(request, "/skills", {
    name,
    content: `---\nname: ${name}\ndescription: User workflow\n---\nKeep this discoverable.`,
  });
  const save = async (hidden_builtins: string[]) => {
    const response = await request.put(`${API_BASE}/skills/settings/visibility`, {
      headers: AUTH_HEADERS,
      data: { hidden_builtins },
    });
    expect(response.ok()).toBe(true);
  };
  try {
    await save([]);
    await gotoView(page, "skills");
    const toggle = page.getByTestId("skill-visibility-orc-sdlc");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(toggle).toHaveText("Visible");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(toggle).toHaveText("Hidden");
    await expect
      .poll(async () =>
        (await apiGet<{ skills: { name: string }[] }>(request, "/skills?scope=global")).skills.some(
          (skill) => skill.name === "orc-sdlc",
        ),
      )
      .toBe(false);
    await page.reload();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(toggle).toHaveText("Hidden");
    expect(
      (
        await request.get(`${API_BASE}/skills/orc-sdlc?ref=SKILL.md`, { headers: AUTH_HEADERS })
      ).ok(),
    ).toBe(true);
    const reopened = await browser.newPage();
    await gotoView(reopened, "skills");
    await expect(reopened.getByTestId("skill-visibility-orc-sdlc")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await reopened.close();
    await expect(page.getByTestId("hide-all-builtins")).toHaveCount(0);
    await expect(page.getByTestId("show-all-builtins")).toHaveCount(0);
    await page.getByTestId("skill-visibility-orc-platform").click();
    await expect(page.getByTestId("skill-visibility-orc-platform")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    const catalog = await apiGet<{ skills: { name: string; source: string }[] }>(
      request,
      "/skills?scope=global",
    );
    expect(catalog.skills.some((skill) => skill.name === name)).toBe(true);
    expect(catalog.skills.some((skill) => skill.name === "orc-platform")).toBe(false);
    await page.getByTestId("skill-source-user").click();
    await expect(
      page.locator(`[data-testid="skill-row"][data-skill-name="${name}"]`),
    ).toBeVisible();
    await page.screenshot({ path: "../../output/playwright/skill-visibility.png", fullPage: true });
    await page.getByTestId("skill-source-all").click();
    await page.getByTestId("skill-visibility-orc-platform").click();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(toggle).toHaveText("Visible");
    expect(
      (await apiGet<{ hidden_builtins: string[] }>(request, "/skills/settings/visibility"))
        .hidden_builtins,
    ).toEqual([]);
  } finally {
    await save(original.hidden_builtins);
  }
});
