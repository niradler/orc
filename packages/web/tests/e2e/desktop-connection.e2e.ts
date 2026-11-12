import { expect, test } from "@playwright/test";
import { gotoView } from "./_helpers";

test("desktop connection edits the shell target through the preload bridge", async ({ page }) => {
  await page.addInitScript(() => {
    const state = {
      mode: "local",
      current: "local",
      url: "",
      has_token: false,
      headers: [],
      editable: true,
    };
    const saved: unknown[] = [];
    Object.assign(window, {
      __desktopConnectionSaved: saved,
      orcDesktop: {
        onOpen: () => () => {},
        connection: {
          state: async () => state,
          test: async () => ({ status: "ready", version: "0.1.64" }),
          save: async (draft: Record<string, unknown>) => {
            saved.push(draft);
            return { ...state, ...draft, has_token: Boolean(draft.token) };
          },
          openLocalSettings: async () => {},
        },
      },
    });
  });
  await gotoView(page, "settings");
  await expect(page.getByTestId("desktop-connection")).toBeVisible();
  await expect(page.getByTestId("settings-api-url")).toHaveCount(0);
  await page.getByTestId("desktop-connection-mode").click();
  await page.getByRole("option", { name: "Remote server" }).click();
  await page.getByTestId("desktop-connection-url").fill("https://orc.example.com");
  await page.getByTestId("desktop-connection-token").fill("desktop-token");
  await page.getByTestId("desktop-connection-header-add").click();
  await page.getByLabel("Header name 1").fill("CF-Access-Client-Id");
  await page.getByLabel("Header value 1").fill("client-id");
  await page.getByTestId("desktop-connection-test").click();
  await expect(page.getByTestId("desktop-connection-result")).toContainText("Connected to ORC");
  await page.getByTestId("desktop-connection-save").click();
  await expect(page.getByTestId("desktop-connection-feedback")).toContainText("Connection saved");
  expect(
    await page.evaluate(
      () => (window as Window & { __desktopConnectionSaved?: unknown[] }).__desktopConnectionSaved,
    ),
  ).toEqual([
    {
      mode: "remote",
      url: "https://orc.example.com",
      token: "desktop-token",
      clear_token: false,
      headers: [{ name: "CF-Access-Client-Id", value: "client-id" }],
    },
  ]);
});

test("a remote desktop window cannot edit the connection from the remote page", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      orcDesktop: {
        onOpen: () => () => {},
        connection: {
          state: async () => ({
            mode: "remote",
            current: "remote",
            url: "https://orc.example.com",
            has_token: true,
            headers: [],
            editable: false,
          }),
          test: async () => ({ status: "ready", version: "0.1.64" }),
          save: async () => {
            throw new Error("not allowed");
          },
          openLocalSettings: async () => {},
        },
      },
    });
  });
  await gotoView(page, "settings");
  await expect(page.getByTestId("desktop-connection")).toContainText("https://orc.example.com");
  await expect(page.getByTestId("desktop-connection-save")).toHaveCount(0);
  await expect(page.getByTestId("desktop-connection-local")).toBeVisible();
});
