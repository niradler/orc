import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { openWorkspaceFolder } from "./_chat-ui";
import { apiDelete, apiGet, gotoView, repoRoot } from "./_helpers";

function bunBinary(): string {
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  const found = execFileSync(lookup, ["bun"], { encoding: "utf8", windowsHide: true })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const exe = found.find((line) => line.endsWith("bun.exe")) ?? found[0];
  if (!exe) throw new Error("bun is not on PATH");
  return exe;
}

async function startRemote(root: string) {
  const home = join(root, "remote-home");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh", "config"), "Host remote-lab\n  HostName 127.0.0.1\n");
  const child = spawn(
    bunBinary(),
    [join(repoRoot(), "packages/api/src/__tests__/fixtures/send-destination.ts")],
    {
      env: {
        ...process.env,
        ORC_HOME: home,
        ORC_DB_PATH: join(home, "orc.db"),
        ORC_API_HOST: "127.0.0.1",
        ORC_API_PORT: "0",
        ORC_API_SECRET: "remote-secret",
        ORC_ACTIVE_PROJECT: "",
        ORC_E2E_CHAT_MOCK: "1",
        HOME: home,
        USERPROFILE: home,
      },
      stdio: ["ignore", "pipe", "inherit"],
      windowsHide: true,
    },
  );
  let buffer = "";
  let port = 0;
  while (!port) {
    const chunk = await new Promise<Buffer | null>((resolve) => {
      child.stdout.once("data", (data: Buffer) => resolve(data));
      child.once("exit", () => resolve(null));
    });
    if (!chunk) throw new Error("The remote ORC exited before reporting its port");
    buffer += chunk.toString("utf8");
    port = Number(buffer.match(/PORT=(\d+)/)?.[1] ?? 0);
  }
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (
    !(await fetch(`${url}/api/health`)
      .then((r) => r.ok)
      .catch(() => false))
  ) {
    if (Date.now() > deadline) throw new Error("The remote ORC did not become healthy");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const stop = () =>
    new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGKILL");
    });
  return { url, home, stop };
}

async function addRemote(page: Page, url: string) {
  await gotoView(page, "settings");
  await page.goto("/settings?settingsSection=hosts");
  await page.getByTestId("remote-host-add").click();
  await page.getByTestId("remote-host-name").fill("Devbox");
  await page.getByTestId("remote-host-url").fill(url);
  await page.getByTestId("remote-host-token").fill("remote-secret");
  await page.getByTestId("remote-host-save").click();
  const row = page.locator('[data-testid^="remote-host-"]').filter({ hasText: "Devbox" });
  await expect(row).toContainText("token saved");
  const { hosts } = await apiGet<{ hosts: { id: string; label: string }[] }>(
    page.request,
    "/remote-hosts",
  );
  const id = hosts.find((host) => host.label === "Devbox")?.id;
  if (!id) throw new Error("Devbox was not saved");
  await page.getByTestId(`remote-host-test-${id}`).click();
  await expect(page.getByTestId(`remote-host-${id}`)).toContainText("Connected to ORC");
  return id;
}

for (const [name, viewport] of [
  ["desktop", { width: 1280, height: 900 }],
  ["phone", { width: 390, height: 844 }],
] as const) {
  test(`${name}: a chat started on a remote ORC host runs there`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize(viewport);
    const root = mkdtempSync(join(tmpdir(), "orc-pw-remote-host-"));
    const remote = await startRemote(root);
    let id = "";
    try {
      id = await addRemote(page, remote.url);
      await page.screenshot({ path: testInfo.outputPath(`hosts-${name}.png`), fullPage: true });

      await page.goto("/?chat=open");
      await expect(page.getByTestId("chat-input")).toBeEnabled();
      await openWorkspaceFolder(page);
      const options = page.getByTestId("chat-workspace-host-option");
      await expect(options.filter({ hasText: "Devbox › remote-lab" })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`picker-${name}.png`) });
      await options.filter({ hasText: /^Devbox\s*Remote ORC/ }).click();
      await page.keyboard.press("Escape");
      await expect(
        page.getByTestId("chat-workspace-folder").filter({ visible: true }),
      ).toContainText("Devbox");

      await page.getByTestId("chat-input").fill("Reply with exactly: REMOTE-E2E.");
      await page.getByTestId("chat-input").press("Enter");
      const note = page.getByText("Started on Devbox");
      await expect(note).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("Reconnecting")).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`started-${name}.png`) });
      await expect(page.getByRole("button", { name: "Open it on Devbox" })).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: `(${remote.url}/chat` })).toHaveCount(
        1,
      );

      const deadline = Date.now() + 30_000;
      let threads = "";
      while (!threads.includes("REMOTE-E2E") && Date.now() < deadline) {
        const response = await fetch(`${remote.url}/api/chat/threads`, {
          headers: { Authorization: "Bearer remote-secret", Connection: "close" },
        });
        const list = (await response.json()) as { threads: { id: string }[] };
        for (const thread of list.threads) {
          const detail = await fetch(`${remote.url}/api/chat/threads/${thread.id}`, {
            headers: { Authorization: "Bearer remote-secret", Connection: "close" },
          });
          threads += JSON.stringify(await detail.json());
        }
        if (!threads.includes("REMOTE-E2E")) await new Promise((r) => setTimeout(r, 300));
      }
      expect(threads).toContain("REMOTE-E2E");
    } finally {
      if (id) await apiDelete(page.request, `/remote-hosts/${id}`).catch(() => {});
      await remote.stop();
      rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    }
  });
}
