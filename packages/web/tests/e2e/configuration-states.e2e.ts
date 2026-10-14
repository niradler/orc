import { expect, test } from "@playwright/test";
import { gotoView } from "./_helpers";

const pages = [
  {
    name: "Knowledgebase",
    view: "knowledge",
    endpoint: "/knowledge/collections",
    empty: { collections: [] },
  },
  { name: "Wiki", view: "wiki", endpoint: "/wiki", empty: { pages: [] } },
  { name: "Memories", view: "memories", endpoint: "/memories", empty: { memories: [], total: 0 } },
  { name: "Skills", view: "skills", endpoint: "/skills", empty: { skills: [], broken: [] } },
  {
    name: "Packages",
    view: "packages",
    endpoint: "/agent-packages",
    empty: { packages: [], broken: [] },
  },
  { name: "Agents", view: "agents", endpoint: "/agents", empty: { agents: [], broken: [] } },
  { name: "Projects", view: "projects", endpoint: "/projects", empty: { projects: [] } },
  {
    name: "Settings",
    view: "settings",
    endpoint: "/ssh",
    empty: { supported: true, host: null, remote_port: 7700, locked: false, hosts: [] },
  },
  {
    name: "Rules",
    view: "rules",
    endpoint: "/rules",
    empty: { enabled: true, events: {}, adapters: [], history: [], decisions: [], actions: [] },
  },
] as const;

for (const scenario of pages) {
  test(`${scenario.name} distinguishes loading, request failure and an empty successful result`, async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let state: "loading" | "failed" | "empty" = "loading";
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() !== "GET" || url.pathname !== `/api${scenario.endpoint}`) {
        await route.continue();
        return;
      }
      if (state === "loading") await released;
      await route.fulfill({
        status: state === "empty" ? 200 : 503,
        contentType: "application/json",
        body: JSON.stringify(
          state === "empty" ? scenario.empty : { error: "Temporary validation outage" },
        ),
      });
    });
    const loading = page.getByTestId("loading-skeleton").or(page.getByTestId("page-loading"));
    const failed = page
      .getByTestId("error-state")
      .or(page.getByTestId("page-error"))
      .or(page.getByTestId("rules-error"))
      .or(page.getByTestId("package-error"));
    const empty = page.getByTestId("empty-state").or(page.getByTestId("page-empty"));
    try {
      await gotoView(page, scenario.view);
      await expect(loading.first()).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`${scenario.view}-loading.png`) });
      state = "failed";
      release();
      await expect(failed.first()).toBeVisible({ timeout: 15_000 });
      await expect(empty).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`${scenario.view}-failed.png`) });
      state = "empty";
      await page.reload();
      if (scenario.view === "settings")
        await expect(page.getByTestId("ssh-settings")).toBeVisible();
      else await expect(empty.first()).toBeVisible();
      await expect(failed).toHaveCount(0);
      await expect(loading).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`${scenario.view}-empty.png`) });
      expect(errors).toEqual([]);
    } finally {
      release();
    }
  });
}
