import { expect, type Page, test } from "@playwright/test";
import { API_SECRET } from "./_helpers";

const ROOT = "/srv/workspaces/a-very-long-folder-name-for-a-populated-picker/repositories";
const CHILD = `${ROOT}/application`;
type Entry = "chat" | "terminal";
type BrowseRequest = { host: string | null; path: string };

function listing(path: string, host: string | null) {
  return {
    host,
    path,
    parent: path === "/" ? null : path.substring(0, path.lastIndexOf("/")) || "/",
    directories:
      path === ROOT
        ? ["application", ...Array.from({ length: 40 }, (_, i) => `project-${i}-with-a-long-name`)]
        : ["child"],
  };
}

async function installFixture(page: Page) {
  const seen: BrowseRequest[] = [];
  await page.addInitScript(
    ({ secret, root }) => {
      localStorage.setItem(`orc_api_secret:${new URL("/api", location.href).href}`, secret);
      localStorage.setItem(
        "orc_folder_history",
        JSON.stringify({
          "ssh:build-box": { last: root, recent: [root] },
          "ssh:other-box": { last: "/opt/other-host", recent: ["/opt/other-host"] },
          local: { last: "/local/only", recent: ["/local/only"] },
        }),
      );
    },
    { secret: API_SECRET, root: ROOT },
  );
  await page.route("**/api/ssh", (route) =>
    route.fulfill({
      json: { host: "build-box", hosts: ["build-box", "other-box"], supported: true },
    }),
  );
  await page.route("**/api/chat/models?**", (route) =>
    route.fulfill({ json: { models: [], warning: null } }),
  );
  await page.route(/\/api\/terminals(?:\?.*)?$/, (route) => {
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({
      json: {
        host: params.has("host") ? params.get("host") || null : "build-box",
        enabled: true,
        ready: true,
        reason: null,
        launchers: ["shell", "codex"],
        terminals: [],
      },
    });
  });
  await page.route("**/api/git/worktrees?**", (route) =>
    route.fulfill({ json: { root: null, worktrees: [] } }),
  );
  await page.route("**/api/terminals/pick-folder", () => {
    throw new Error("SSH folder selection must not open a native dialog");
  });
  await page.route("**/api/terminals/browse?**", (route) => {
    const params = new URL(route.request().url()).searchParams;
    const request = { host: params.get("host"), path: params.get("path") || ROOT };
    seen.push(request);
    return route.fulfill({ json: listing(request.path, request.host) });
  });
  return seen;
}

async function openEntry(page: Page, entry: Entry) {
  if (entry === "chat") {
    await page.goto("/tasks?chat=open");
    await page.getByTestId("chat-input").fill("Preserve this chat draft while browsing folders");
    await expect(page.getByTestId("chat-workspace-path")).toHaveAttribute(
      "title",
      `build-box: ${ROOT}`,
    );
  } else {
    await page.goto("/terminals?project=all");
    await page.getByTestId("terminal-new").click();
    await expect(page.getByTestId("terminal-cwd")).toHaveValue(ROOT);
  }
}

async function browse(page: Page, entry: Entry) {
  await page.getByTestId(entry === "chat" ? "chat-workspace-browse" : "terminal-browse").click();
  await expect(page.getByTestId("folder-picker-dialog")).toBeVisible();
}

async function expectSelection(page: Page, entry: Entry, path: string, host = "build-box") {
  if (entry === "chat") {
    await expect(page.getByTestId("chat-workspace-path")).toHaveAttribute(
      "title",
      `${host}: ${path}`,
    );
    await expect(page.getByTestId("chat-input")).toHaveValue(
      "Preserve this chat draft while browsing folders",
    );
  } else {
    await expect(page.getByTestId("terminal-launch-menu")).toBeVisible();
    await expect(page.getByTestId("terminal-cwd")).toHaveValue(path);
    await expect(page.getByTestId("terminal-host-select")).toHaveValue(host);
  }
}

for (const entry of ["chat", "terminal"] as const) {
  test(`${entry} uses the shared folder dialog for navigation, selection and cancellation`, async ({
    page,
  }, testInfo) => {
    const seen = await installFixture(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openEntry(page, entry);
    await browse(page, entry);
    const dialog = page.getByTestId("folder-picker-dialog");
    const currentFolder = page.getByTestId("remote-folder-crumb").last();
    await expect(currentFolder).toHaveAttribute("title", ROOT);
    await expect(dialog).toContainText("build-box");
    const application = page
      .getByTestId("remote-folder-entry")
      .filter({ hasText: /^application$/ });
    await application.click();
    await expect(application).toHaveAttribute("aria-pressed", "true");
    await expect(currentFolder).toHaveAttribute("title", ROOT);
    await expectSelection(page, entry, ROOT);

    for (const width of [1440, 390, 320]) {
      const addressDraft = `${ROOT}/not-applied-at-${width}`;
      if (width !== 1440) {
        await page.getByTestId("remote-folder-edit-address").click();
        await page.getByTestId("remote-folder-address").fill(addressDraft);
      }
      await page.setViewportSize({ width, height: 900 });
      await expect(dialog).toBeVisible();
      if (width !== 1440) {
        await expect(page.getByTestId("remote-folder-address")).toHaveValue(addressDraft);
        await page.getByTestId("remote-folder-address").press("Escape");
        await expect(dialog).toBeVisible();
      }
      await expect(application).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("remote-folder-selection")).toHaveValue(CHILD);
      for (const id of ["back", "forward", "up", "edit-address", "pick", "cancel"]) {
        const control = page.getByTestId(`remote-folder-${id}`);
        await expect(control).toBeVisible();
        if (width < 640) {
          const box = await control.boundingBox();
          expect(box?.height).toBeGreaterThanOrEqual(44);
          expect(box?.width).toBeGreaterThanOrEqual(44);
        }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const scroll = await page.getByTestId("remote-folder-list").evaluate((element) => ({
        height: element.clientHeight,
        content: element.scrollHeight,
      }));
      expect(scroll.content).toBeGreaterThan(scroll.height);
      for (const theme of ["dark", "light"]) {
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
          document.documentElement.classList.toggle("dark", theme === "dark");
          document.documentElement.style.colorScheme = theme;
        }, theme);
        // Dialog colors transition when the theme changes; capture the settled, readable state.
        const foreground = theme === "dark" ? "rgb(229, 229, 229)" : "rgb(37, 38, 42)";
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(dialog).toHaveCSS(
          "background-color",
          theme === "dark" ? "rgb(28, 28, 28)" : "rgb(243, 243, 245)",
        );
        await expect(dialog).toHaveCSS("color", foreground);
        await expect(application).toHaveCSS("color", foreground);
        await expect(page.getByTestId("remote-folder-browser")).toHaveCSS(
          "background-color",
          theme === "dark" ? "rgb(0, 0, 0)" : "rgb(250, 250, 250)",
        );
        const colors = await dialog.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            theme: document.documentElement.dataset.theme,
            foreground: style.color,
            background: style.backgroundColor,
            transitionProperty: style.transitionProperty,
            transitionDuration: style.transitionDuration,
          };
        });
        await testInfo.attach(`${entry}-folder-picker-${width}-${theme}-colors`, {
          body: JSON.stringify(colors),
          contentType: "application/json",
        });
        await page.screenshot({
          path: testInfo.outputPath(`${entry}-folder-picker-${width}-${theme}.png`),
        });
      }
    }

    await application.focus();
    await application.press("ArrowDown");
    await expect(page.getByTestId("remote-folder-entry").nth(1)).toBeFocused();
    await page.getByTestId("remote-folder-entry").nth(1).press("ArrowUp");
    await expect(application).toBeFocused();
    await application.press("Enter");
    await expect(currentFolder).toHaveAttribute("title", CHILD);
    await page.getByTestId("remote-folder-back").click();
    await expect(currentFolder).toHaveAttribute("title", ROOT);
    await page.getByTestId("remote-folder-forward").click();
    await expect(currentFolder).toHaveAttribute("title", CHILD);
    await page.getByTestId("remote-folder-up").click();
    await expect(currentFolder).toHaveAttribute("title", ROOT);
    await page.getByTestId("remote-folder-crumb").filter({ hasText: /^srv$/ }).click();
    await expect(currentFolder).toHaveAttribute("title", "/srv");
    await page.getByTestId("remote-folder-edit-address").click();
    const address = page.getByTestId("remote-folder-address");
    await expect(address).toBeFocused();
    await address.fill("/srv/address-jump");
    await address.press("Enter");
    await expect(page.getByTestId("remote-folder-selection")).toHaveValue("/srv/address-jump");
    await page.getByTestId("remote-folder-cancel").click();
    await expect(dialog).toBeHidden();
    await expectSelection(page, entry, ROOT);

    await browse(page, entry);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expectSelection(page, entry, ROOT);
    await page.setViewportSize({ width: 1440, height: 900 });
    await browse(page, entry);
    await page.mouse.click(2, 2);
    await expect(dialog).toBeHidden();
    await expectSelection(page, entry, ROOT);

    await browse(page, entry);
    await application.click();
    await page.getByTestId("remote-folder-pick").click();
    await expect(dialog).toBeHidden();
    await expectSelection(page, entry, CHILD);
    if (entry === "chat") {
      await page.getByTestId("chat-workspace-host").click();
      await page.getByTestId("chat-workspace-host-option").filter({ hasText: "other-box" }).click();
    } else {
      await page.getByTestId("terminal-host-select").selectOption("other-box");
    }
    await browse(page, entry);
    await expect(currentFolder).toHaveAttribute("title", "/opt/other-host");
    await expect(dialog).toContainText("other-box");
    await page.getByTestId("remote-folder-pick").click();
    await expectSelection(page, entry, "/opt/other-host", "other-box");
    expect(seen.at(-1)).toEqual({ host: "other-box", path: "/opt/other-host" });
    expect(
      seen.every((request) => request.host === "build-box" || request.host === "other-box"),
    ).toBe(true);
  });

  test(`${entry} cannot confirm stale folders while navigation loads or fails`, async ({
    page,
  }) => {
    await installFixture(page);
    let releaseFailure = () => {};
    const pending = new Promise<void>((resolveFailure) => {
      releaseFailure = resolveFailure;
    });
    let childRequests = 0;
    await page.route("**/api/terminals/browse?**", async (route) => {
      const params = new URL(route.request().url()).searchParams;
      const path = params.get("path") || ROOT;
      if (path === CHILD && ++childRequests === 1) {
        await pending;
        return route.fulfill({ status: 503, json: { error: "Folder listing unavailable" } });
      }
      return route.fulfill({ json: listing(path, params.get("host")) });
    });
    await openEntry(page, entry);
    await browse(page, entry);
    await page.getByRole("button", { name: "Open folder application", exact: true }).click();
    try {
      await expect.poll(() => childRequests).toBe(1);
      await expect(page.getByTestId("remote-folder-loading")).toBeVisible();
      await expect(page.getByTestId("remote-folder-pick")).toBeDisabled();
      await expectSelection(page, entry, ROOT);
    } finally {
      releaseFailure();
    }
    await expect(page.getByTestId("remote-folder-error")).toContainText(
      "Folder listing unavailable",
    );
    await expect(page.getByTestId("remote-folder-pick")).toBeDisabled();
    await expect(page.getByTestId("remote-folder-entry").first()).toBeDisabled();
    await expectSelection(page, entry, ROOT);
    await page.getByTestId("remote-folder-retry").click();
    await expect(page.getByTestId("remote-folder-error")).toBeHidden();
    await expect(page.getByTestId("remote-folder-pick")).toBeEnabled();
    await expect(page.getByTestId("remote-folder-crumb").last()).toHaveAttribute("title", CHILD);
    await page.getByTestId("remote-folder-pick").click();
    await expectSelection(page, entry, CHILD);
    expect(childRequests).toBe(2);
  });
}
