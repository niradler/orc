import { expect, test } from "@playwright/test";
import { settingsSection } from "./_chat-ui";
import { gotoView } from "./_helpers";

test("SSH uses automatic port by default and permits a persistent override", async ({ page }) => {
  let state = {
    host: "test-host",
    remote_port: null as number | null,
    hosts: ["test-host"],
    locked: false,
    supported: true,
    unsupported_reason: null,
    secret_set: true,
  };
  await page.route("**/api/ssh", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      state = { ...state, ...body };
    }
    await route.fulfill({ json: state });
  });
  await gotoView(page, "settings");
  await settingsSection(page, "execution");
  const port = page.getByTestId("ssh-remote-port");
  await expect(port).toHaveValue("");
  await expect(port).toHaveAttribute("placeholder", "Automatic");
  await page.getByTestId("ssh-save").click();
  await expect.poll(() => state.remote_port).toBeNull();
  await port.fill("45871");
  await page.getByTestId("ssh-save").click();
  await expect.poll(() => state.remote_port).toBe(45871);
  await page.reload();
  await expect(port).toHaveValue("45871");
  await port.fill("");
  await page.getByTestId("ssh-save").click();
  await expect.poll(() => state.remote_port).toBeNull();
  await page.reload();
  await expect(port).toHaveValue("");
});
