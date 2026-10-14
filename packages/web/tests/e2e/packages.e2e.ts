import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { unzipSync } from "fflate";
import { gotoView, tid } from "./_helpers";

test("portable package import, tabbed files, lossless export and edit/use flow survive reopening", async ({
  page,
}) => {
  const name = tid("portable-package");
  const root = mkdtempSync(join(tmpdir(), "orc-portable-browser-"));
  const folder = join(root, "different-folder-name");
  mkdirSync(join(folder, "skills", "portable-check"), { recursive: true });
  const manifest = JSON.stringify(
    {
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name,
      description: "Reusable portable configuration",
      "x-preserved": { original: true },
    },
    null,
    2,
  );
  writeFileSync(join(folder, "plugin.json"), manifest);
  writeFileSync(
    join(folder, "skills", "portable-check", "SKILL.md"),
    "---\nname: portable-check\ndescription: Portable browser fixture\n---\nUse this skill.",
  );
  writeFileSync(join(folder, "asset.bin"), Buffer.from([0, 255, 1, 128]));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await gotoView(page, "skills");
  await page.getByTestId("nav-packages").click();
  await page.getByTestId("package-import-button").click();
  await page.getByTestId("package-import-folder").click();
  await page.getByTestId("agent-package-folder").setInputFiles(folder);
  const card = page.locator(`[data-testid="agent-package-row"][data-package-name="${name}"]`);
  await expect(card).toContainText("Agent Plugins");
  await page.reload();
  await expect(page.getByTestId("package-file-content")).toContainText("x-preserved");
  const downloading = page.waitForEvent("download");
  await page.getByTestId("package-export").click();
  const download = await downloading;
  const archivePath = await download.path();
  if (!archivePath) throw Error("Missing exported archive");
  const files = unzipSync(readFileSync(archivePath));
  const exportedManifest = files[`${name}/plugin.json`];
  const exportedAsset = files[`${name}/asset.bin`];
  if (!exportedManifest || !exportedAsset) throw Error("Missing exported package files");
  expect(Buffer.from(exportedManifest).toString()).toBe(manifest);
  expect(Array.from(exportedAsset)).toEqual([0, 255, 1, 128]);
  await page.keyboard.press("Escape");
  await card.getByTestId("package-run").click();
  await expect(page.getByTestId("setup-components")).toContainText("1 skill files");
  await expect(page.getByTestId("setup-save")).toHaveCount(0);
  await expect(page.getByTestId("setup-name")).toHaveCount(0);
  await page.getByTestId("setup-cwd").fill(root);
  await page.getByTestId("setup-prompt").fill("Use the portable package");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("packages-setups-tab")).toHaveCount(0);
  await expect(page.getByTestId("workspace-sidebar").getByTestId("nav-agents")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await card.getByTestId("package-card-edit").click();
  await expect(page.getByRole("tab", { name: "plugin.json", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "asset.bin", exact: true }).click();
  await expect(page.getByTestId("package-file-input")).toHaveAttribute("contenteditable", "false");
  await page.getByRole("tab", { name: "plugin.json", exact: true }).click();
  await expect(page.getByTestId("package-file-input")).toContainText("x-preserved");
  const dialog = page.getByRole("dialog");
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
    true,
  );
  await page.getByTestId("package-editor-configuration").click();
  await page.getByTestId("package-description-input").fill("Edited package purpose");
  await page.getByTestId("package-submit").click();
  await page.reload();
  await expect(card).toContainText("Edited package purpose");
  expect(errors).toEqual([]);
  await page.screenshot({
    path: "../../.claude/portable-packages-browser.png",
  });
});
