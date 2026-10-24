import { expect, test } from "@playwright/test";
import { API_BASE, AUTH_HEADERS, apiGet, apiPost, gotoView, tid } from "./_helpers";

test("built-in visibility saves, reopens, and preserves user skills and named reads", async ({
  page,
  request,
  browser,
}) => {
  const original = await apiGet<{ hidden_builtins: string[]; hidden_skills: string[] }>(
    request,
    "/skills/settings/visibility",
  );
  const name = tid("pw-visible-user");
  await apiPost(request, "/skills", {
    name,
    content: `---\nname: ${name}\ndescription: User workflow\n---\nKeep this discoverable.`,
  });
  const save = async (hidden_builtins: string[], hidden_skills: string[] = []) => {
    const response = await request.put(`${API_BASE}/skills/settings/visibility`, {
      headers: AUTH_HEADERS,
      data: { hidden_builtins, hidden_skills },
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
    await save(original.hidden_builtins, original.hidden_skills);
  }
});

test("user and modified skills have persistent visibility toggles", async ({ page, request }) => {
  const name = tid("pw-all-visible");
  await apiPost(request, "/skills", {
    name,
    content: `---\nname: ${name}\ndescription: User visibility workflow\n---\nOriginal instructions.`,
  });
  await gotoView(page, "skills");
  const toggle = page.getByTestId(`skill-visibility-${name}`);
  await expect(toggle).toHaveText("Visible");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(toggle).toHaveText("Hidden");
  await page.reload();
  await expect(toggle).toHaveText("Hidden");
  const catalog = await apiGet<{ skills: { name: string }[] }>(request, "/skills?scope=global");
  expect(catalog.skills.some((skill) => skill.name === name)).toBe(false);
  const raw = await apiGet<{ content: string }>(
    request,
    `/skills/${name}?scope=global&ref=SKILL.md`,
  );
  expect(raw.content).toContain("Original instructions.");
  await expect(toggle).toBeEnabled();
  await toggle.press("Space");
  await expect(toggle).toHaveText("Visible");
  const updated = await request.put(`${API_BASE}/skills/${name}/instructions`, {
    headers: AUTH_HEADERS,
    data: {
      project_id: null,
      content: `${raw.content}\nEdited instructions.`,
      expected_content: raw.content,
      reason: "Verify modified skill toggle",
    },
  });
  expect(updated.status()).toBe(200);
  await page.reload();
  await expect(toggle).toHaveText("Visible (Modified)");
  await toggle.click();
  await expect(toggle).toHaveText("Hidden (Modified)");
  await page.reload();
  await expect(toggle).toHaveText("Hidden (Modified)");
  await page.screenshot({
    path: "../../output/playwright/skills-all-visibility.png",
    fullPage: true,
  });
  await toggle.click();
  await expect(toggle).toHaveText("Visible (Modified)");
});
