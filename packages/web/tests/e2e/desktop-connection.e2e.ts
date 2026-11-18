import { expect, test } from "@playwright/test";
import { gotoView } from "./_helpers";

test("desktop hosts save, use and delete servers through the preload bridge", async ({ page }) => {
  await page.addInitScript(() => {
    type Server = {
      id: string;
      label: string;
      url: string;
      has_token: boolean;
      headers: { name: string; value: string }[];
    };
    const state = {
      mode: "local",
      current: "local",
      url: "",
      has_token: false,
      headers: [],
      editable: true,
      active: null as string | null,
      servers: [] as Server[],
    };
    const calls: unknown[] = [];
    const snapshot = () => structuredClone(state);
    Object.assign(window, {
      __desktopCalls: calls,
      orcDesktop: {
        onOpen: () => () => {},
        connection: {
          state: async () => snapshot(),
          test: async () => ({ status: "ready", version: "0.1.64" }),
          save: async (draft: Record<string, unknown>) => {
            calls.push({ save: draft });
            const id = (draft.id as string | undefined) ?? `server-${state.servers.length + 1}`;
            const server = {
              id,
              label: (draft.label as string) || "orc.example.com",
              url: draft.url as string,
              has_token: Boolean(draft.token),
              headers: draft.headers as Server["headers"],
            };
            state.servers = draft.id
              ? state.servers.map((item) => (item.id === id ? server : item))
              : [...state.servers, server];
            if (!draft.id) state.active = id;
            return snapshot();
          },
          use: async (id: string | null) => {
            calls.push({ use: id });
            state.active = id;
            return snapshot();
          },
          remove: async (id: string) => {
            calls.push({ remove: id });
            state.servers = state.servers.filter((server) => server.id !== id);
            if (state.active === id) state.active = null;
            return snapshot();
          },
          openLocalSettings: async () => {},
        },
      },
    });
  });
  await gotoView(page, "settings");
  await page.goto("/settings?settingsSection=connection");
  await expect(page.getByTestId("desktop-host-local")).toContainText("Active");
  await expect(page.getByTestId("browser-hosts")).toHaveCount(0);

  await page.getByTestId("desktop-host-add").click();
  await page.getByTestId("desktop-host-name").fill("Work");
  await page.getByTestId("desktop-host-url").fill("https://orc.example.com");
  await page.getByTestId("desktop-host-token").fill("desktop-token");
  await page.getByTestId("api-host-header-add").click();
  await page.getByLabel("Header name 1").fill("CF-Access-Client-Id");
  await page.getByLabel("Header value 1").fill("client-id");
  await page.getByTestId("desktop-host-test").click();
  await expect(page.getByTestId("desktop-host-test-result")).toContainText("Connected to ORC");
  await page.getByTestId("desktop-host-save").click();
  await expect(page.getByTestId("desktop-host-server-1")).toContainText("Active");
  await expect(page.getByTestId("desktop-host-server-1")).toContainText("token saved · 1 header");

  await page.getByTestId("desktop-host-add").click();
  await page.getByTestId("desktop-host-url").fill("https://home.example.com");
  await page.getByTestId("desktop-host-save").click();
  await expect(page.getByTestId("desktop-host-server-2")).toContainText("Active");

  await page.getByTestId("desktop-host-use-server-1").click();
  await expect(page.getByTestId("desktop-host-server-1")).toContainText("Active");
  await page.getByTestId("desktop-host-delete-server-1").click();
  await page.getByTestId("confirm-dialog-confirm").click();
  await expect(page.getByTestId("desktop-host-server-1")).toHaveCount(0);
  await expect(page.getByTestId("desktop-host-local")).toContainText("Active");

  expect(
    await page.evaluate(() => (window as Window & { __desktopCalls?: unknown[] }).__desktopCalls),
  ).toEqual([
    {
      save: {
        label: "Work",
        url: "https://orc.example.com",
        token: "desktop-token",
        clear_token: false,
        headers: [{ name: "CF-Access-Client-Id", value: "client-id" }],
      },
    },
    {
      save: {
        label: "",
        url: "https://home.example.com",
        token: "",
        clear_token: false,
        headers: [],
      },
    },
    { use: "server-1" },
    { remove: "server-1" },
  ]);
});

test("a remote desktop window cannot edit the servers from the remote page", async ({ page }) => {
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
            active: "work",
            servers: [],
          }),
          test: async () => ({ status: "ready", version: "0.1.64" }),
          save: async () => {
            throw new Error("not allowed");
          },
          use: async () => {
            throw new Error("not allowed");
          },
          remove: async () => {
            throw new Error("not allowed");
          },
          openLocalSettings: async () => {},
        },
      },
    });
  });
  await gotoView(page, "settings");
  await page.goto("/settings?settingsSection=connection");
  await expect(page.getByTestId("host-row-api")).toContainText("https://orc.example.com");
  await expect(page.getByTestId("desktop-host-add")).toHaveCount(0);
  await expect(page.getByTestId("desktop-connection-local")).toBeVisible();
});
