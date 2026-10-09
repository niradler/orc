import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { unzipSync } from "fflate";
import { apiGet, gotoView, tid } from "./_helpers";

test("portable package import, resource inspection, lossless export and saved setup survive reopening", async ({
  page,
  request,
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
  await page.getByTestId("agent-package-folder").setInputFiles(folder);
  const card = page.locator(`[data-testid="agent-package-row"][data-package-name="${name}"]`);
  await expect(card).toContainText("Agent Plugins");
  await page.reload();
  await card.getByTestId("package-inspect").click();
  await expect(page.getByTestId("package-file-content")).toContainText("x-preserved");
  await page.keyboard.press("Escape");
  const downloading = page.waitForEvent("download");
  await card.getByTestId("package-export").click();
  const download = await downloading;
  const archivePath = await download.path();
  if (!archivePath) throw Error("Missing exported archive");
  const files = unzipSync(readFileSync(archivePath));
  const exportedManifest = files[`${name}/plugin.json`];
  const exportedAsset = files[`${name}/asset.bin`];
  if (!exportedManifest || !exportedAsset) throw Error("Missing exported package files");
  expect(Buffer.from(exportedManifest).toString()).toBe(manifest);
  expect(Array.from(exportedAsset)).toEqual([0, 255, 1, 128]);
  await card.getByTestId("package-run").click();
  await expect(page.getByTestId("setup-components")).toContainText("1 skill files");
  await page.getByTestId("setup-name").fill(name);
  await page.getByTestId("setup-cwd").fill(root);
  await page.getByTestId("setup-model").fill("selected-model");
  await page.getByTestId("setup-prompt").fill("Use the portable package");
  await page.getByTestId("setup-save").click();
  await expect(page.getByTestId("agent-setup-row").filter({ hasText: name })).toBeVisible();
  await page.reload();
  await page.getByTestId("agent-setup-row").filter({ hasText: name }).click();
  await expect(page.getByTestId("setup-cwd")).toHaveValue(root);
  await expect(page.getByTestId("setup-model")).toHaveValue("selected-model");
  await expect(page.getByTestId("setup-prompt")).toHaveValue("Use the portable package");
  const stored = await apiGet<{ setups: { name: string; packages: string[] }[] }>(
    request,
    "/agent-setups",
  );
  expect(stored.setups.find((setup) => setup.name === name)?.packages).toEqual([name]);
  expect(errors).toEqual([]);
  await page.screenshot({ path: "../../.claude/portable-packages-browser.png" });
});
