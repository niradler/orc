import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import AxeBuilder from "@axe-core/playwright";
import type { HumanRequest } from "@orc/core/human-requests";
import { expect, test } from "@playwright/test";
import {
  apiDelete,
  apiPost,
  gotoView,
  reviewAttentionRequest,
  tid,
  toggleThemeInPlace,
} from "./_helpers";

const screenshotDir = process.env.ORC_SCREENSHOT_DIR;

async function snap(page: import("@playwright/test").Page, name: string): Promise<void> {
  if (!screenshotDir) return;
  mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({
    path: `${screenshotDir}/${name}.png`,
    fullPage: false,
    animations: "disabled",
  });
}

test("@sanity should run a command with a picked saved project secret without echoing its value on desktop and phone", async ({
  page,
  request,
}) => {
  const projectName = tid("demo-deploy");
  const project = await apiPost<{ id: string; name: string }>(request, "/projects", {
    name: projectName,
    description: "Synthetic deploy service for command secret verification",
  });
  const secretValue = "sk-demo-deploy-token-556677";

  try {
    await apiPost(request, `/projects/${project.id}/secrets`, {
      name: "deploy-token",
      value: secretValue,
      description: "Deploy credential reused by reviewed commands",
    });

    // TOKEN opted in; TARGET did not, so a reference-shaped value typed there
    // must reach the script literally (TLEN=13 proves no silent substitution).
    const script =
      process.platform === "win32"
        ? '[Console]::Out.Write("LEN=" + ($env:ORC_INPUT_TOKEN).Length + " RAW=" + $env:ORC_INPUT_TOKEN + " TLEN=" + ($env:ORC_INPUT_TARGET).Length)'
        : 'printf "LEN=%s RAW=%s TLEN=%s" "$(printf %s "$ORC_INPUT_TOKEN" | wc -c | tr -d " ")" "$ORC_INPUT_TOKEN" "$(printf %s "$ORC_INPUT_TARGET" | wc -c | tr -d " ")"';
    const entry = await apiPost<HumanRequest>(request, "/human-requests", {
      kind: "command",
      project_id: project.id,
      title: "Verify deploy credentials",
      prompt: "Run a credential check using a saved project secret.",
      origin: {
        backend: "codex",
        session_id: tid("command-secret-ui"),
        session_title: "Deploy credential check",
        request_id: tid("req-command-secret"),
      },
      command: {
        host: null,
        cwd: tmpdir(),
        script,
        arguments: [
          { name: "TOKEN", label: "Deploy token", required: true, allow_secret_ref: true },
          { name: "TARGET", label: "Target name", required: true },
        ],
      },
    });

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoView(page, "notifications");
    await page.goto(`/notifications?request=${encodeURIComponent(entry.id)}`);
    const card = page.getByTestId(`attention-request-${entry.id}`);
    await expect(card).toBeVisible();
    await reviewAttentionRequest(card);

    // Opt-in UI: the picker and masking appear for TOKEN only; TARGET stays a
    // plain, literal field.
    const picker = card.getByTestId("attention-argument-secret-TOKEN");
    await expect(picker).toBeVisible();
    await expect(card.getByTestId("attention-argument-TOKEN")).toHaveAttribute("type", "password");
    await expect(card.getByTestId("attention-argument-secret-TARGET")).toHaveCount(0);
    await expect(card.getByTestId("attention-argument-TARGET")).toHaveAttribute("type", "text");

    // Pick the saved secret: the masked input is replaced by the non-secret reference.
    await picker.click();
    await page.getByRole("option", { name: "deploy-token" }).click();
    await expect(card.getByTestId("attention-argument-ref-TOKEN")).toHaveText(
      "project/deploy-token",
    );
    await expect(card.getByTestId("attention-argument-TOKEN")).toHaveCount(0);
    await expect(card.getByTestId("attention-secret-injection-note")).toContainText(
      "injects 1 saved secret",
    );
    await expect(card).not.toContainText(secretValue);
    await card.getByTestId("attention-argument-TARGET").fill("project/ghost");

    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    const cardAxe = await new AxeBuilder({ page })
      .include(`[data-testid="attention-request-${entry.id}"]`)
      .analyze();
    expect(cardAxe.violations).toEqual([]);

    await snap(page, "command-secret-picker-desktop-dark");
    await toggleThemeInPlace(page);
    await snap(page, "command-secret-picker-desktop-light");
    await toggleThemeInPlace(page);

    // Phone parity: zero overflow and >=44px touch targets for picker and Run.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(picker).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await expect
      .poll(async () => (await picker.boundingBox())?.height ?? 0)
      .toBeGreaterThanOrEqual(44);
    await expect
      .poll(async () => (await card.getByTestId("attention-run").boundingBox())?.height ?? 0)
      .toBeGreaterThanOrEqual(44);
    await snap(page, "command-secret-picker-phone");

    // Switching back to manual entry restores the masked input.
    await page.setViewportSize({ width: 1440, height: 900 });
    await picker.click();
    await page.getByRole("option", { name: "Type a value" }).click();
    await expect(card.getByTestId("attention-argument-TOKEN")).toHaveAttribute("type", "password");
    await expect(card.getByTestId("attention-argument-ref-TOKEN")).toHaveCount(0);

    // Re-pick the saved secret and run; the result is redacted and never echoes the value.
    await picker.click();
    await page.getByRole("option", { name: "deploy-token" }).click();
    await card.getByTestId("attention-run").click();
    const result = card.getByTestId("attention-command-result");
    await expect(result).toBeVisible();
    await expect(result).toContainText(`LEN=${secretValue.length}`);
    await expect(result).toContainText("RAW=[REDACTED]");
    await expect(result).toContainText("TLEN=13");
    await expect(result).not.toContainText(secretValue);
    await expect(card).not.toContainText(secretValue);
    await snap(page, "command-secret-result-desktop");
  } finally {
    await apiDelete(request, `/projects/${project.id}?ttl_days=0`).catch(() => {});
  }
});

test("@sanity should warn inline when a projectless request carries a typed secret reference", async ({
  page,
  request,
}) => {
  const entry = await apiPost<HumanRequest>(request, "/human-requests", {
    kind: "command",
    title: "No-project credential check",
    prompt: "This request has no project, so saved secrets are unavailable.",
    origin: {
      backend: "codex",
      session_id: tid("command-noproject-ui"),
      session_title: "Project-less command",
      request_id: tid("req-command-noproject"),
    },
    command: {
      host: null,
      cwd: tmpdir(),
      script: "true",
      arguments: [{ name: "TOKEN", label: "Deploy token", allow_secret_ref: true }],
    },
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await gotoView(page, "notifications");
  await page.goto(`/notifications?request=${encodeURIComponent(entry.id)}`);
  const card = page.getByTestId(`attention-request-${entry.id}`);
  await expect(card).toBeVisible();
  await reviewAttentionRequest(card);

  // No picker without a project; the field stays masked because it is opted in.
  await expect(card.getByTestId("attention-argument-secret-TOKEN")).toHaveCount(0);
  await expect(card.getByTestId("attention-argument-TOKEN")).toHaveAttribute("type", "password");
  await expect(card.getByTestId("attention-argument-noproject-TOKEN")).toHaveCount(0);

  // Typing a reference-shaped value triggers the inline project requirement warning.
  await card.getByTestId("attention-argument-TOKEN").fill("project/ghost");
  await expect(card.getByTestId("attention-argument-noproject-TOKEN")).toBeVisible();
  await expect(card.getByTestId("attention-argument-noproject-TOKEN")).toContainText(
    "no project to resolve",
  );
  // Nothing injects without a project, so the injection note must not appear.
  await expect(card.getByTestId("attention-secret-injection-note")).toHaveCount(0);
  await snap(page, "command-secret-noproject-desktop");
});
