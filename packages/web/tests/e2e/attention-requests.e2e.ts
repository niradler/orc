import AxeBuilder from "@axe-core/playwright";
import type { HumanRequest } from "@orc/core/human-requests";
import { expect, test } from "@playwright/test";
import { apiGet, apiPost, gotoView, repoRoot, reviewAttentionRequest, tid } from "./_helpers";

test("should review compact requests, preserve masked drafts and return redacted multi-input output", async ({
  page,
  request,
}) => {
  const values = {
    ACCOUNT: "private-account-631",
    TOKEN: "private-token-823",
    ENDPOINT: "private-endpoint-427",
  };
  const script =
    process.platform === "win32"
      ? '[Console]::Out.Write($env:ORC_INPUT_ACCOUNT + "|" + $env:ORC_INPUT_TOKEN + "|" + $env:ORC_INPUT_ENDPOINT)'
      : 'printf "%s|%s|%s" "$ORC_INPUT_ACCOUNT" "$ORC_INPUT_TOKEN" "$ORC_INPUT_ENDPOINT"';
  const entries: HumanRequest[] = [];
  for (let index = 0; index < 8; index++)
    entries.push(
      await apiPost<HumanRequest>(request, "/human-requests", {
        title: index === 0 ? "Connect the service" : `Review service request ${index}`,
        kind: "command",
        prompt:
          "The agent needs these values to check the service connection. Review the command before running it.",
        origin: { backend: "codex", session_id: tid("secure-form"), request_id: String(index) },
        command: {
          host: null,
          cwd: repoRoot(),
          script,
          arguments: [
            {
              name: "ACCOUNT",
              label: "Account",
              description: "The account used for this connection.",
            },
            {
              name: "TOKEN",
              label: "Access token",
              description: "Used only for this connection check.",
            },
            { name: "ENDPOINT", label: "Service endpoint" },
          ],
        },
      }),
    );
  let runs = 0;
  page.on("request", (sent) => {
    if (sent.method() === "POST" && /\/human-requests\/[^/]+\/run$/.test(sent.url())) runs++;
  });
  await gotoView(page, "attention");
  const card = page.getByTestId(`attention-request-${entries[0]?.id}`);
  const other = page.getByTestId(`attention-request-${entries[1]?.id}`);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(card.getByTestId("attention-review")).toHaveAttribute("aria-expanded", "false");
    for (const entry of entries) {
      const bounds = await page.getByTestId(`attention-request-${entry.id}`).boundingBox();
      expect(bounds?.height).toBeLessThanOrEqual(72);
    }
    await page.screenshot({
      path: `../../output/playwright/attention-compact-${width}.png`,
      fullPage: true,
      animations: "disabled",
    });
  }
  await reviewAttentionRequest(card);
  await expect(card).toContainText("The agent needs these values");
  await expect(card.getByTestId("attention-command-preview")).toHaveText(script);
  await expect(card.getByTestId("attention-command")).toHaveCount(0);
  for (const [name, value] of Object.entries(values)) {
    const input = card.getByTestId(`attention-argument-${name}`);
    const variable = `ORC_INPUT_${name}`;
    await expect(card.getByTestId(`attention-argument-name-${name}`)).toHaveText(variable);
    await expect(card.getByTestId("attention-command-preview")).toContainText(variable);
    await expect(input).toHaveAccessibleName(new RegExp(variable));
    await expect(input).toHaveAttribute("type", "password");
    await input.fill(value);
  }
  await reviewAttentionRequest(other);
  await expect(card.getByTestId("attention-review")).toHaveAttribute("aria-expanded", "false");
  await reviewAttentionRequest(card);
  for (const [name, value] of Object.entries(values))
    await expect(card.getByTestId(`attention-argument-${name}`)).toHaveValue(value);
  const late = await apiPost<HumanRequest>(request, "/human-requests", {
    kind: "question",
    prompt: "A new request must stay closed",
    origin: { backend: "codex", session_id: tid("new-arrival"), request_id: "later" },
  });
  await expect(
    page.getByTestId(`attention-request-${late.id}`).getByTestId("attention-review"),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(card.getByTestId("attention-review")).toHaveAttribute("aria-expanded", "true");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(card.getByTestId("attention-run")).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `../../output/playwright/attention-review-${width}.png`,
      fullPage: true,
      animations: "disabled",
    });
  }
  expect(runs).toBe(0);
  const accessibility = await new AxeBuilder({ page })
    .include(`[data-testid="attention-request-${entries[0]?.id}"]`)
    .analyze();
  expect(accessibility.violations).toEqual([]);
  await card.getByTestId("attention-run").click();
  await expect(card.getByTestId("attention-command-result")).toContainText(
    "[REDACTED]|[REDACTED]|[REDACTED]",
  );
  expect(runs).toBe(1);
  const completed = await apiGet<HumanRequest>(request, `/human-requests/${entries[0]?.id}`);
  for (const value of Object.values(values)) {
    expect(JSON.stringify(completed)).not.toContain(value);
    await expect(card).not.toContainText(value);
  }
  await page.reload();
  await expect(card.getByTestId("attention-review")).toHaveAttribute("aria-expanded", "false");
  await reviewAttentionRequest(card);
  await expect(card.getByTestId("attention-command-result")).toContainText(
    "[REDACTED]|[REDACTED]|[REDACTED]",
  );
  await reviewAttentionRequest(other);
  await other.getByTestId("attention-cancel").click();
  await expect(other).toHaveCount(0);
  expect(runs).toBe(1);
});

for (const width of [320, 390])
  test.describe(`secure request on a ${width}px touch phone`, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true });
    test("should keep review and secure input actions reachable with 44px targets", async ({
      page,
      request,
    }) => {
      const script =
        process.platform === "win32"
          ? '[Console]::Out.Write($env:ORC_INPUT_ACCOUNT + "|" + $env:ORC_INPUT_KEY)'
          : 'printf "%s|%s" "$ORC_INPUT_ACCOUNT" "$ORC_INPUT_KEY"';
      const entry = await apiPost<HumanRequest>(request, "/human-requests", {
        kind: "command",
        title: "Verify the connection",
        prompt: "These values are needed only for this connection check.",
        origin: { backend: "codex", session_id: tid("touch-request"), request_id: "touch" },
        command: {
          host: null,
          cwd: repoRoot(),
          script,
          arguments: [
            { name: "ACCOUNT", label: "Account" },
            { name: "KEY", label: "Access key" },
          ],
        },
      });
      await gotoView(page, "attention");
      const card = page.getByTestId(`attention-request-${entry.id}`);
      await card.getByTestId("attention-review").tap();
      await card.getByTestId("attention-argument-ACCOUNT").fill("private-touch-account");
      await card.getByTestId("attention-argument-KEY").fill("private-touch-key");
      for (const name of ["ACCOUNT", "KEY"]) {
        await expect(card.getByTestId(`attention-argument-name-${name}`)).toHaveText(
          `ORC_INPUT_${name}`,
        );
        await expect(card.getByTestId("attention-command-preview")).toContainText(
          `ORC_INPUT_${name}`,
        );
      }
      await card.scrollIntoViewIfNeeded();
      for (const testId of [
        "attention-review",
        "attention-edit-command",
        "attention-argument-ACCOUNT",
        "attention-argument-KEY",
        "attention-run",
        "attention-cancel",
        "attention-input-help",
      ]) {
        const bounds = await card.getByTestId(testId).boundingBox();
        expect(bounds?.width).toBeGreaterThanOrEqual(44);
        expect(bounds?.height).toBeGreaterThanOrEqual(44);
        expect(bounds?.x).toBeGreaterThanOrEqual(0);
        expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(width);
        expect(bounds?.y).toBeGreaterThanOrEqual(0);
        expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(844);
      }
      await page.screenshot({
        path: `../../output/playwright/attention-secure-touch-${width}.png`,
        fullPage: true,
        animations: "disabled",
      });
      await card.getByTestId("attention-run").tap();
      await expect(card.getByTestId("attention-command-result")).toContainText(
        "[REDACTED]|[REDACTED]",
      );
      await expect(card).not.toContainText("private-touch");
    });
  });
