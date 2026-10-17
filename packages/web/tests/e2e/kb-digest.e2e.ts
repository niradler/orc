import { expect, type Page, test } from "@playwright/test";
import { API_BASE, AUTH_HEADERS, apiDelete, apiGet, apiPost, gotoView, tid } from "./_helpers";

type Kb = { id: string; name: string };
type Doc = { id: string; title: string };
type Digest = {
  backend: string;
  enabled: boolean;
  schedule: { type: "cron"; cron: string } | { type: "manual" };
  instructions: string;
};

async function createKb(request: Parameters<typeof apiPost>[0], name: string): Promise<Kb> {
  return apiPost<Kb>(request, "/kb/bases", { name, project_id: null });
}

async function openKb(page: Page, name: string): Promise<void> {
  await gotoView(page, "knowledge");
  await page.locator(`[data-testid="kb-row"][data-kb-name="${name}"]`).click();
  await expect(page.getByTestId("kb-overview-name")).toHaveText(name);
}

async function noHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe("Knowledge base digest", () => {
  test("add a digest from the template, run it, edit it and remove it", async ({
    page,
    request,
  }) => {
    const kb = await createKb(request, tid("pw-kb-digest"));
    try {
      const { instructions: template } = await apiGet<{ instructions: string }>(
        request,
        "/kb/digest-template",
      );
      await openKb(page, kb.name);
      const section = page.getByTestId("kb-digest");
      await section.getByTestId("kb-digest-add").click();

      const dialog = page.getByRole("dialog");
      await expect(dialog.getByTestId("kb-digest-instructions")).toContainText(
        template.split("\n")[0] ?? "",
      );
      await expect(dialog.getByTestId("kb-digest-cron")).toHaveValue("0 3 * * *");
      // a2a without a URL fails at once, so the run is recorded without starting a real agent.
      await dialog.getByTestId("kb-digest-backend").click();
      await page.getByRole("option", { name: /^a2a / }).click();
      await dialog.getByTestId("kb-digest-schedule").click();
      await page.getByRole("option", { name: "Manual only" }).click();
      await expect(dialog.getByTestId("kb-digest-cron")).toHaveCount(0);
      await dialog.getByTestId("kb-digest-save").click();
      await expect(dialog).toHaveCount(0);

      await expect(section.getByTestId("kb-digest-summary")).toContainText("a2a");
      await expect(section.getByTestId("kb-digest-summary")).toContainText("manual only");
      await expect(section.getByTestId("kb-digest-enabled")).toHaveText("enabled");
      await expect(section.getByTestId("kb-digest-last-run")).toHaveAttribute(
        "data-status",
        "never",
      );
      const saved = await apiGet<{ digest: Digest }>(request, `/kb/bases/${kb.id}/digest`);
      expect(saved.digest.instructions).toBe(template.trim());
      expect(saved.digest.schedule).toEqual({ type: "manual" });

      await section.getByTestId("kb-digest-run").click();
      await expect(section.getByTestId("kb-digest-run-started")).toBeVisible();
      const run = section.getByTestId("kb-digest-run-row").first();
      await expect(run).toBeVisible();
      // The run ends quickly (failed for a2a without a URL); its time is a real date, not 1970.
      await expect(run).toHaveAttribute("data-status", /^(pending|running|failed|success)$/);
      await expect(run).not.toContainText("1970");

      await section.getByTestId("kb-digest-toggle").click();
      await expect(section.getByTestId("kb-digest-enabled")).toHaveText("disabled");
      await section.getByTestId("kb-digest-toggle").click();
      await expect(section.getByTestId("kb-digest-enabled")).toHaveText("enabled");

      await section.getByTestId("kb-digest-edit").click();
      await expect(dialog.getByTestId("kb-digest-instructions")).toContainText(
        template.split("\n")[0] ?? "",
      );
      await dialog.getByTestId("kb-digest-schedule").click();
      await page.getByRole("option", { name: "Cron schedule" }).click();
      await dialog.getByTestId("kb-digest-cron").fill("0 4 * * 1");
      await dialog.getByTestId("kb-digest-instructions").fill("Keep the runbooks current.");
      await dialog.getByTestId("kb-digest-save").click();
      await expect(dialog).toHaveCount(0);
      await expect(section.getByTestId("kb-digest-summary")).toContainText("cron 0 4 * * 1");
      const edited = await apiGet<{ digest: Digest }>(request, `/kb/bases/${kb.id}/digest`);
      expect(edited.digest.instructions).toBe("Keep the runbooks current.");
      expect(edited.digest.backend).toBe("a2a");

      await section.getByTestId("kb-digest-remove").click();
      const confirm = dialog.getByTestId("kb-digest-remove-confirm");
      await expect(confirm).toBeDisabled();
      await dialog.getByTestId("kb-digest-remove-input").fill("wrong name");
      await expect(confirm).toBeDisabled();
      await dialog.getByTestId("kb-digest-remove-input").fill(kb.name);
      await confirm.click();
      await expect(dialog).toHaveCount(0);
      await expect(section.getByTestId("kb-digest-add")).toBeVisible();
      const removed = await apiGet<{ digest: Digest | null }>(request, `/kb/bases/${kb.id}/digest`);
      expect(removed.digest).toBeNull();
    } finally {
      await apiDelete(request, `/kb/bases/${kb.id}`);
    }
  });

  test("a digest needs MCP edit access and the dialog says so", async ({ page, request }) => {
    const kb = await apiPost<Kb>(request, "/kb/bases", {
      name: tid("pw-kb-digest-nomcp"),
      project_id: null,
      editable_by: ["ui", "api"],
    });
    try {
      await openKb(page, kb.name);
      await page.getByTestId("kb-digest-add").click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByTestId("kb-digest-mcp-hint")).toBeVisible();
      await expect(dialog.getByTestId("kb-digest-instructions")).toBeVisible();
      await dialog.getByTestId("kb-digest-save").click();
      await expect(dialog.getByTestId("kb-dialog-error")).toContainText("allow mcp");
    } finally {
      await apiDelete(request, `/kb/bases/${kb.id}`);
    }
  });
});

test.describe("Knowledge base comments", () => {
  test("comment on a knowledge base and a document, resolve, reopen and dismiss", async ({
    page,
    request,
  }) => {
    const kb = await createKb(request, tid("pw-kb-comments"));
    try {
      const doc = await apiPost<Doc>(request, `/kb/bases/${kb.id}/documents`, {
        title: "Deploy runbook",
        content: "# Deploy runbook\n\nSteps.",
      });
      await openKb(page, kb.name);
      const kbComments = page.getByTestId("kb-comments");
      await expect(kbComments.getByTestId("kb-comments-empty")).toBeVisible();
      await kbComments.getByTestId("kb-comment-input").fill("Add a page about rollbacks");
      await kbComments.getByTestId("kb-comment-add").click();
      const kbComment = kbComments.getByTestId("kb-comment");
      await expect(kbComment).toHaveCount(1);
      await expect(kbComment).toContainText("Add a page about rollbacks");
      await expect(kbComment).toContainText("ui");
      await expect(kbComments.getByTestId("kb-comment-input")).toHaveValue("");

      // Comment on the open document.
      await page
        .locator(`[data-testid="kb-document-row"][data-document-title="Deploy runbook"]`)
        .click();
      await expect(page.getByTestId("kb-document-title")).toHaveText("Deploy runbook");
      const docComments = page.getByTestId("kb-document-details").getByTestId("kb-comments");
      await docComments.getByTestId("kb-comment-input").fill("Step 2 is out of date");
      await docComments.getByTestId("kb-comment-add").click();
      const docComment = docComments.getByTestId("kb-comment");
      await expect(docComment).toHaveCount(1);
      await expect(docComment).toContainText("Step 2 is out of date");

      // Resolving needs a reply.
      await docComment.getByTestId("kb-comment-resolve").click();
      await expect(docComment.getByTestId("kb-comment-close-submit")).toBeDisabled();
      await docComment.getByTestId("kb-comment-reply").fill("Updated step 2");
      await docComment.getByTestId("kb-comment-close-submit").click();
      await expect(docComments.getByTestId("kb-comment")).toHaveCount(0);

      await docComments.getByTestId("kb-comments-filter").click();
      await page.getByRole("option", { name: "Resolved" }).click();
      const resolved = docComments.getByTestId("kb-comment");
      await expect(resolved).toHaveAttribute("data-status", "resolved");
      await expect(resolved.getByTestId("kb-comment-reply-text")).toContainText("Updated step 2");
      await resolved.getByTestId("kb-comment-reopen").click();
      await expect(docComments.getByTestId("kb-comment")).toHaveCount(0);

      await docComments.getByTestId("kb-comments-filter").click();
      await page.getByRole("option", { name: "Open" }).click();
      const reopened = docComments.getByTestId("kb-comment");
      await expect(reopened).toHaveAttribute("data-status", "open");
      await reopened.getByTestId("kb-comment-dismiss").click();
      await reopened.getByTestId("kb-comment-reply").fill("Step 2 is still right");
      await reopened.getByTestId("kb-comment-close-submit").click();
      await expect(docComments.getByTestId("kb-comment")).toHaveCount(0);

      const { comments } = await apiGet<{
        comments: { body: string; status: string; reply: string | null; document_id: string }[];
      }>(request, `/kb/bases/${kb.id}/comments?document_id=${doc.id}&status=dismissed`);
      expect(comments).toHaveLength(1);
      expect(comments[0]?.reply).toBe("Step 2 is still right");

      // The knowledge base list shows document comments too, with a link to the document.
      await page.getByTestId("kb-row").filter({ hasText: kb.name }).click();
      await kbComments.getByTestId("kb-comments-filter").click();
      await page.getByRole("option", { name: "All" }).click();
      await expect(kbComments.getByTestId("kb-comment")).toHaveCount(2);
      await expect(kbComments).toContainText("on Deploy runbook");
    } finally {
      await apiDelete(request, `/kb/bases/${kb.id}`);
    }
  });

  test("closing a comment surfaces the server's refusal when the UI may not edit", async ({
    page,
    request,
  }) => {
    const kb = await apiPost<Kb>(request, "/kb/bases", {
      name: tid("pw-kb-comments-ro"),
      project_id: null,
      editable_by: ["mcp"],
    });
    try {
      await apiPost(request, `/kb/bases/${kb.id}/comments`, { body: "Please fix" });
      await openKb(page, kb.name);
      const comment = page.getByTestId("kb-comments").getByTestId("kb-comment");
      await comment.getByTestId("kb-comment-resolve").click();
      await comment.getByTestId("kb-comment-reply").fill("Done");
      await comment.getByTestId("kb-comment-close-submit").click();
      await expect(comment.getByTestId("kb-comment-error")).toBeVisible();
      await expect(comment).toHaveAttribute("data-status", "open");
    } finally {
      await apiDelete(request, `/kb/bases/${kb.id}`);
    }
  });

  for (const width of [390, 320]) {
    test(`digest and comments fit a ${width}px screen`, async ({ page, request }) => {
      const kb = await createKb(request, tid("pw-kb-digest-mobile"));
      try {
        await apiPost(request, `/kb/bases/${kb.id}/comments`, {
          body: "A long comment that should wrap instead of pushing the page sideways on a phone",
        });
        const put = await request.put(`${API_BASE}/kb/bases/${kb.id}/digest`, {
          headers: AUTH_HEADERS,
          data: { instructions: "Keep it current.", backend: "a2a", schedule: { type: "manual" } },
        });
        expect(put.ok()).toBe(true);
        await page.setViewportSize({ width, height: 800 });
        await gotoView(page, "knowledge");
        await page.goto(`/knowledge/base?kb=${kb.id}`);
        await expect(page.getByTestId("kb-overview-name")).toHaveText(kb.name);
        await expect(page.getByTestId("kb-digest-summary")).toBeVisible();
        await expect(page.getByTestId("kb-comment")).toHaveCount(1);
        await noHorizontalOverflow(page);
        await page.getByTestId("kb-digest-edit").click();
        await expect(page.getByTestId("kb-digest-instructions")).toBeVisible();
        await noHorizontalOverflow(page);
      } finally {
        await apiDelete(request, `/kb/bases/${kb.id}`);
      }
    });
  }
});
