import { mkdirSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import type { HumanRequest } from "@orc/core/human-requests";
import { expect, test } from "@playwright/test";
import {
  apiDelete,
  apiGet,
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

test("@sanity should answer multi-field secret requests without echoing values and manage project secrets on desktop and phone", async ({
  page,
  request,
}) => {
  const projectName = tid("demo-billing");
  const project = await apiPost<{ id: string; name: string }>(request, "/projects", {
    name: projectName,
    description: "Synthetic billing service for secret workflow verification",
  });

  const apiKeyValue = "sk-demo-billing-key-884422";
  const baseUrlValue = "https://sandbox.billing.internal/v1";
  const directTokenValue = "tok-direct-delivery-773311";

  try {
    const saveable = await apiPost<HumanRequest>(request, "/human-requests", {
      project_id: project.id,
      kind: "secret",
      title: "Connect OpenAI gateway",
      prompt:
        "Provide credentials for the billing eval worker. Values stay hidden and can be saved for reuse.",
      save_to_project: true,
      fields: [
        {
          key: "OPENAI_API_KEY",
          label: "OpenAI API key",
          description: "Used by the evaluation pipeline.",
          required: true,
          link: "https://platform.openai.com/api-keys?project=demo-billing-workspace-integration",
          reference_name: "openai-key",
        },
        {
          key: "BASE_URL",
          label: "API base URL",
          description: "Optional custom gateway endpoint.",
          required: true,
          reference_name: "openai-base-url",
        },
      ],
      origin: {
        backend: "codex",
        session_id: tid("secret-ui"),
        session_title: "Billing eval integration",
        request_id: tid("req-save"),
      },
    });

    const directOnly = await apiPost<HumanRequest>(request, "/human-requests", {
      kind: "secret",
      title: "One-time staging token",
      prompt: "Provide a short-lived staging token for this check only.",
      fields: [
        {
          key: "STAGING_TOKEN",
          label: "Staging token",
          required: true,
        },
      ],
      origin: {
        backend: "claude",
        session_id: tid("secret-direct"),
        session_title: "Staging smoke check",
        request_id: tid("req-direct"),
      },
    });

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoView(page, "notifications");
    await page.goto(`/notifications?request=${encodeURIComponent(saveable.id)}`);
    const card = page.getByTestId(`attention-request-${saveable.id}`);
    await expect(card).toBeVisible();
    await reviewAttentionRequest(card);

    const apiKeyInput = card.getByTestId("secret-field-OPENAI_API_KEY");
    const baseUrlInput = card.getByTestId("secret-field-BASE_URL");
    await expect(apiKeyInput).toHaveAttribute("type", "password");
    await expect(baseUrlInput).toHaveAttribute("type", "password");
    await expect(card.getByTestId("secret-link-OPENAI_API_KEY")).toBeVisible();

    await apiKeyInput.fill(apiKeyValue);
    await baseUrlInput.fill(baseUrlValue);

    // Reveal only the second field to prove independent per-field show/hide toggles.
    await card.getByTestId("secret-toggle-BASE_URL").click();
    await expect(baseUrlInput).toHaveAttribute("type", "text");
    await expect(apiKeyInput).toHaveAttribute("type", "password");
    await expect(card.getByTestId("secret-save-to-project")).toBeChecked();
    await expect(card.getByTestId("secret-ref-name-OPENAI_API_KEY")).toHaveValue("openai-key");

    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    const cardAxe = await new AxeBuilder({ page })
      .include(`[data-testid="attention-request-${saveable.id}"]`)
      .analyze();
    expect(cardAxe.violations).toEqual([]);

    await snap(page, "secret-card-desktop-dark");

    await toggleThemeInPlace(page);
    await snap(page, "secret-card-desktop-light");
    await toggleThemeInPlace(page);

    // Phone layout check: zero horizontal overflow and >=44px touch targets.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(card).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    const submitBox = await card.getByTestId("secret-submit").boundingBox();
    expect(submitBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    const toggleBox = await card.getByTestId("secret-toggle-OPENAI_API_KEY").boundingBox();
    expect(toggleBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    await snap(page, "secret-card-phone");

    // Back to desktop to submit and inspect the non-echoing receipt.
    await page.setViewportSize({ width: 1440, height: 900 });
    await card.getByTestId("secret-submit").click();
    await expect(card.getByTestId("secret-receipt")).toBeVisible();
    await expect(card.getByTestId("secret-receipt-ref-OPENAI_API_KEY")).toHaveText(
      "project/openai-key",
    );
    await expect(card.getByTestId("secret-receipt-ref-BASE_URL")).toHaveText(
      "project/openai-base-url",
    );
    await expect(card).not.toContainText(apiKeyValue);
    await expect(card).not.toContainText(baseUrlValue);
    await snap(page, "secret-receipt-desktop");

    // Verify direct-delivery card (no project) via deep link delivers without echoing value.
    await page.goto(`/notifications?request=${encodeURIComponent(directOnly.id)}`);
    const directCard = page.getByTestId(`attention-request-${directOnly.id}`);
    await expect(directCard).toBeVisible();
    await reviewAttentionRequest(directCard);
    const stagingInput = directCard.getByTestId("secret-field-STAGING_TOKEN");
    await stagingInput.fill(directTokenValue);
    await expect(stagingInput).toHaveValue(directTokenValue);
    await directCard.getByTestId("secret-submit").click();
    await expect(directCard.getByTestId("secret-receipt")).toContainText("Delivered to the agent");
    await expect(directCard).not.toContainText(directTokenValue);
    const storedView = await apiGet<HumanRequest>(request, `/human-requests/${directOnly.id}/view`);
    expect(JSON.stringify(storedView)).not.toContain(directTokenValue);

    // Open Settings -> Secrets and verify full project secret management lifecycle.
    await page.goto("/settings?settingsSection=secrets");
    await expect(page.getByTestId("project-secrets-settings")).toBeVisible();
    await page.getByTestId("project-secrets-project-select").click();
    await page.getByRole("option", { name: projectName }).click();

    await expect(page.getByTestId("project-secret-row-openai-key")).toBeVisible();
    await expect(page.getByTestId("project-secret-row-openai-base-url")).toBeVisible();
    await expect(page.getByTestId("project-secrets-settings")).not.toContainText(apiKeyValue);
    await expect(page.getByTestId("project-secrets-settings")).not.toContainText(baseUrlValue);

    // Create a new secret via on-demand editor.
    await page.getByTestId("project-secret-add").click();
    await expect(page.getByTestId("project-secret-editor")).toBeVisible();
    await page.getByTestId("project-secret-name-input").fill("stripe-webhook-secret");
    await page.getByTestId("project-secret-value-input").fill("whsec-demo-secret-112233");
    await page.getByTestId("project-secret-description-input").fill("Webhook signature verifier");
    await page.getByTestId("project-secret-save").click();
    await expect(page.getByTestId("project-secret-row-stripe-webhook-secret")).toBeVisible();
    await expect(page.getByTestId("project-secrets-settings")).not.toContainText(
      "whsec-demo-secret-112233",
    );

    // Check reference (validates decryptability & updates last_used_at).
    await page.getByTestId("project-secret-check-openai-key").click();
    await expect(page.getByTestId("project-secret-check-result-openai-key")).toContainText(
      "Secret is stored and decryptable",
    );
    await expect(page.getByTestId("project-secret-meta-openai-key")).toContainText("Last used");

    const settingsAxe = await new AxeBuilder({ page })
      .include('[data-testid="project-secrets-settings"]')
      .analyze();
    expect(settingsAxe.violations).toEqual([]);

    await snap(page, "settings-secrets-desktop-dark");
    await toggleThemeInPlace(page);
    await snap(page, "settings-secrets-desktop-light");
    await toggleThemeInPlace(page);

    // Rotate secret value without revealing old or new value.
    await page.getByTestId("project-secret-rotate-openai-key").click();
    await expect(page.getByTestId("project-secret-value-input")).toHaveValue("");
    await page.getByTestId("project-secret-value-input").fill("sk-demo-rotated-key-991100");
    await page.getByTestId("project-secret-save").click();
    await expect(page.getByTestId("project-secret-editor")).toHaveCount(0);
    await expect(page.getByTestId("project-secrets-settings")).not.toContainText(
      "sk-demo-rotated-key-991100",
    );

    // Phone viewport check on Settings -> Secrets.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("project-secret-row-openai-key")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    const addBox = await page.getByTestId("project-secret-add").boundingBox();
    expect(addBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    await snap(page, "settings-secrets-phone");

    // Delete secret with explicit confirmation.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId("project-secret-delete-stripe-webhook-secret").click();
    await page.getByTestId("confirm-dialog-confirm").click();
    await expect(page.getByTestId("project-secret-row-stripe-webhook-secret")).toHaveCount(0);
  } finally {
    await apiDelete(request, `/projects/${project.id}`).catch(() => {});
  }
});
