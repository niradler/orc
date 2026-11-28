import { expect, type Page, test } from "@playwright/test";
import { API_BASE, AUTH_HEADERS, apiDelete, apiGet, apiPost, gotoView, tid } from "./_helpers";
import { openKbContext, selectKnowledgeBase } from "./_knowledge-ui";

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
  await selectKnowledgeBase(page, name);
}

async function noHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

type Backend = { name: string; available: boolean; tool_allowlist: boolean };

/** Every backend the picker offers; a digest can run on any of them. */
async function allBackends(request: Parameters<typeof apiGet>[0]): Promise<Backend[]> {
  const { backends } = await apiGet<{ backends: Backend[] }>(request, "/backends");
  return backends;
}

/** Backends that enforce the digest's tool whitelist; the picker suggests one of these. */
async function digestBackends(request: Parameters<typeof apiGet>[0]): Promise<Backend[]> {
  return (await allBackends(request)).filter((b) => b.tool_allowlist);
}

test.describe("Knowledge base digest", () => {
  test("add a digest from the template, edit it and remove it", async ({ page, request }) => {
    const kb = await createKb(request, tid("pw-kb-digest"));
    try {
      const { instructions: template } = await apiGet<{ instructions: string }>(
        request,
        "/kb/digest-template",
      );
      const capable = await digestBackends(request);
      expect(capable.length).toBeGreaterThan(0);
      await openKb(page, kb.name);
      await openKbContext(page);
      const section = page.getByTestId("kb-digest");
      await section.getByTestId("kb-digest-add").click();

      const dialog = page.getByRole("dialog");
      await expect(dialog.getByTestId("kb-digest-instructions")).toContainText(
        template.split("\n")[0] ?? "",
      );
      // The schedule comes first and starts as the daily 03:00 preset.
      await expect(dialog.getByTestId("kb-digest-schedule")).toBeFocused();
      await expect(dialog.getByTestId("kb-digest-schedule")).toHaveText("Every day");
      await expect(dialog.getByTestId("kb-digest-time")).toHaveValue("03:00");
      const preview = dialog.getByTestId("kb-digest-schedule-preview");
      await expect(preview).toContainText("Runs daily at 03:00");
      // A custom cron previews in words and explains a bad one before saving.
      await dialog.getByTestId("kb-digest-schedule").click();
      await page.getByRole("option", { name: "Custom cron" }).click();
      await expect(dialog.getByTestId("kb-digest-cron")).toHaveValue("0 3 * * *");
      await dialog.getByTestId("kb-digest-cron").fill("0 */6 * * *");
      await expect(preview).toContainText("Runs every 6 hours");
      await dialog.getByTestId("kb-digest-cron").fill("0 25 * * *");
      await expect(preview).toHaveAttribute("data-valid", "false");
      await expect(preview).toContainText('The hour field "25" is not valid');
      await expect(dialog.getByTestId("kb-digest-save")).toBeDisabled();
      // Any backend can run a digest. Ones that cannot enforce its tool whitelist are marked,
      // not hidden; the digest then runs without the whitelist.
      const all = await allBackends(request);
      await dialog.getByTestId("kb-digest-backend").click();
      for (const { name } of capable)
        await expect(page.getByRole("option", { name: new RegExp(`^${name} `) })).toBeVisible();
      for (const { name } of all.filter((b) => !b.tool_allowlist))
        await expect(page.getByRole("option", { name: new RegExp(`^${name} `) })).toHaveAttribute(
          "data-backend-tool-allowlist",
          "false",
        );
      await expect(page.getByRole("option", { name: /^a2a / })).toBeVisible();
      const chosen = (capable.find((b) => b.available) ?? capable[0]).name;
      await page.getByRole("option", { name: new RegExp(`^${chosen} `) }).click();
      await dialog.getByTestId("kb-digest-schedule").click();
      await page.getByRole("option", { name: "Manual only" }).click();
      await expect(dialog.getByTestId("kb-digest-cron")).toHaveCount(0);
      await expect(preview).toHaveText("Runs only when you start it.");
      await dialog.getByTestId("kb-digest-save").click();
      await expect(dialog).toHaveCount(0);

      await expect(section.getByTestId("kb-digest-enabled")).toHaveText("On");
      await expect(section.getByTestId("kb-digest-summary")).toContainText(
        "runs when you start it",
      );
      // A manual digest has no schedule to pause.
      await expect(section.getByTestId("kb-digest-toggle")).toHaveCount(0);
      await expect(section.getByTestId("kb-digest-last-run")).toHaveAttribute(
        "data-status",
        "never",
      );
      const saved = await apiGet<{ digest: Digest }>(request, `/kb/bases/${kb.id}/digest`);
      expect(saved.digest.instructions).toBe(template.trim());
      expect(saved.digest.schedule).toEqual({ type: "manual" });
      expect(saved.digest.backend).toBe(chosen);

      // The details name the agent; the summary line stays short. Starting a run is not part of
      // this flow: it would drive a real agent, and the run itself is covered by the runner tests.
      await section.getByTestId("kb-digest-expand").click();
      await expect(section.getByTestId("kb-digest-expand")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      await expect(section).toContainText(chosen);

      await section.getByTestId("kb-digest-edit").click();
      await expect(dialog.getByTestId("kb-digest-instructions")).toContainText(
        template.split("\n")[0] ?? "",
      );
      await dialog.getByTestId("kb-digest-schedule").click();
      await page.getByRole("option", { name: "Once a week" }).click();
      await dialog.getByTestId("kb-digest-day").click();
      await page.getByRole("option", { name: "Monday" }).click();
      await dialog.getByTestId("kb-digest-time").fill("04:00");
      await expect(dialog.getByTestId("kb-digest-schedule-preview")).toContainText(
        "Runs Mondays at 04:00 (0 4 * * 1)",
      );
      await dialog.getByTestId("kb-digest-instructions").fill("Keep the runbooks current.");
      await dialog.getByTestId("kb-digest-save").click();
      await expect(dialog).toHaveCount(0);
      await expect(section.getByTestId("kb-digest-summary")).toContainText("Mondays at 04:00");
      await expect(section.getByTestId("kb-digest-next-run")).toContainText("next run");
      await expect(section.getByTestId("kb-digest-enabled")).toHaveText("On");
      await expect(section.getByTestId("kb-digest-toggle")).toHaveText("Pause schedule");
      await section.getByTestId("kb-digest-toggle").click();
      await expect(section.getByTestId("kb-digest-enabled")).toHaveText("Paused");
      // A paused schedule has no next run.
      await expect(section.getByTestId("kb-digest-next-run")).toHaveCount(0);
      await section.getByTestId("kb-digest-toggle").click();
      await expect(section.getByTestId("kb-digest-enabled")).toHaveText("On");
      const edited = await apiGet<{ digest: Digest }>(request, `/kb/bases/${kb.id}/digest`);
      expect(edited.digest.instructions).toBe("Keep the runbooks current.");
      expect(edited.digest.backend).toBe(chosen);
      expect(edited.digest.schedule).toEqual({ type: "cron", cron: "0 4 * * 1" });

      // Removing lives in the digest settings, away from everyday actions. Documents stay, so a
      // plain confirm is enough, and the run list must not ask for the removed digest's runs.
      const missing: string[] = [];
      page.on("response", (res) => {
        if (res.url().includes("/digest/runs") && res.status() === 404) missing.push(res.url());
      });
      await section.getByTestId("kb-digest-edit").click();
      await dialog.getByTestId("kb-digest-remove").click();
      await expect(dialog).toContainText("Documents and comments stay");
      await dialog.getByTestId("kb-digest-remove-confirm").click();
      await expect(dialog).toHaveCount(0);
      await expect(section.getByTestId("kb-digest-add")).toBeVisible();
      expect(missing).toEqual([]);
      const removed = await apiGet<{ digest: Digest | null }>(request, `/kb/bases/${kb.id}/digest`);
      expect(removed.digest).toBeNull();
    } finally {
      await apiDelete(request, `/kb/bases/${kb.id}`);
    }
  });

  test("a backend that cannot enforce the whitelist is marked, and the digest still runs there", async ({
    page,
    request,
  }) => {
    const kb = await createKb(request, tid("pw-kb-digest-stale"));
    try {
      const capable = await digestBackends(request);
      // Any backend is a valid digest choice; start paused only to exercise enabling it.
      const paused = await request.put(`${API_BASE}/kb/bases/${kb.id}/digest`, {
        headers: AUTH_HEADERS,
        data: { backend: "a2a", schedule: { type: "cron", cron: "0 3 * * *" }, enabled: false },
      });
      expect(paused.status()).toBe(200);

      await openKb(page, kb.name);
      await openKbContext(page);
      const section = page.getByTestId("kb-digest");
      await expect(section.getByTestId("kb-digest-enabled")).toHaveText("Paused");
      await section.getByTestId("kb-digest-expand").click();
      await section.getByTestId("kb-digest-edit").click();

      const dialog = page.getByRole("dialog");
      // The stored value stays visible and the picker says what choosing it means.
      await expect(dialog.getByTestId("kb-digest-backend")).toContainText("a2a");
      await expect(dialog.getByTestId("backend-picker-hint")).toContainText(
        "cannot enforce a digest's tool whitelist",
      );
      await expect(dialog.getByTestId("backend-picker-hint")).toContainText("without it");
      await dialog.getByTestId("kb-digest-backend").click();
      await expect(page.getByRole("option", { name: /^a2a / })).toHaveAttribute(
        "data-backend-tool-allowlist",
        "false",
      );
      await expect(page.getByRole("option", { name: /^claude / })).toHaveAttribute(
        "data-backend-tool-allowlist",
        "true",
      );
      await page.keyboard.press("Escape");
      await dialog.getByTestId("kb-digest-cancel").click();
      await expect(dialog).toHaveCount(0);

      // Enabling is not refused: the digest is valid and runs without the whitelist.
      await section.getByTestId("kb-digest-toggle").click();
      await expect(section.getByTestId("kb-digest-enabled")).toHaveText("On");
      const enabled = await apiGet<{ digest: Digest }>(request, `/kb/bases/${kb.id}/digest`);
      expect(enabled.digest).toMatchObject({ backend: "a2a", enabled: true });

      // A capable backend can still be chosen, and the warning goes away.
      await section.getByTestId("kb-digest-edit").click();
      await dialog.getByTestId("kb-digest-backend").click();
      const fix = (capable.find((b) => b.available) ?? capable[0]).name;
      await page.getByRole("option", { name: new RegExp(`^${fix} `) }).click();
      await expect(dialog.getByTestId("backend-picker-hint")).not.toContainText("without it");
      await dialog.getByTestId("kb-digest-save").click();
      await expect(dialog).toHaveCount(0);
      const healed = await apiGet<{ digest: Digest }>(request, `/kb/bases/${kb.id}/digest`);
      expect(healed.digest.backend).toBe(fix);
      expect(healed.digest.enabled).toBe(true);
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
      await openKbContext(page);
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
      await openKbContext(page);
      const kbComments = page.getByTestId("kb-comments");
      // Collapsed by default: only the header and the counts take space.
      await expect(kbComments.getByTestId("kb-comments-none")).toBeVisible();
      await expect(kbComments.getByTestId("kb-comment-input")).toHaveCount(0);
      await kbComments.getByTestId("kb-comments-toggle").click();
      await expect(kbComments.getByTestId("kb-comments-toggle")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      // "None yet" in the summary is the only empty state.
      await expect(kbComments.getByTestId("kb-comments-none")).toBeVisible();
      await expect(kbComments.getByTestId("kb-comments-empty")).toHaveCount(0);
      await kbComments.getByTestId("kb-comment-input").fill("Add a page about rollbacks");
      await kbComments.getByTestId("kb-comment-add").click();
      const kbComment = kbComments.getByTestId("kb-comment");
      await expect(kbComment).toHaveCount(1);
      await expect(kbComment).toContainText("Add a page about rollbacks");
      await expect(kbComment).toContainText("ui");
      await expect(kbComments.getByTestId("kb-comment-input")).toHaveValue("");
      await expect(kbComments.getByTestId("kb-comments-count-open")).toContainText("1");

      // Comment on the open document.
      await page
        .locator(`[data-testid="kb-document-row"][data-document-title="Deploy runbook"]`)
        .click();
      await expect(page.getByTestId("kb-document-title")).toHaveText("Deploy runbook");
      await page.getByTestId("kb-details-toggle").click();
      const docComments = page.getByTestId("kb-document-details").getByTestId("kb-comments");
      await docComments.getByTestId("kb-comments-toggle").click();
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
      await expect(docComment).toHaveAttribute("data-status", "resolved");
      await expect(docComments.getByTestId("kb-comments-count-resolved")).toContainText("1");
      await expect(docComments.getByTestId("kb-comments-count-open")).toHaveCount(0);

      // A count filters the list to its status.
      await docComments.getByTestId("kb-comments-count-resolved").click();
      await expect(docComments.getByTestId("kb-comments-count-resolved")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      const resolved = docComments.getByTestId("kb-comment");
      await expect(resolved).toHaveAttribute("data-status", "resolved");
      await expect(resolved.getByTestId("kb-comment-reply-text")).toContainText("Updated step 2");
      await resolved.getByTestId("kb-comment-reopen").click();
      await expect(docComments.getByTestId("kb-comment")).toHaveCount(0);

      await docComments.getByTestId("kb-comments-count-open").click();
      const reopened = docComments.getByTestId("kb-comment");
      await expect(reopened).toHaveAttribute("data-status", "open");
      await reopened.getByTestId("kb-comment-dismiss").click();
      await reopened.getByTestId("kb-comment-reply").fill("Step 2 is still right");
      await reopened.getByTestId("kb-comment-close-submit").click();
      await expect(docComments.getByTestId("kb-comment")).toHaveCount(0);
      await expect(docComments.getByTestId("kb-comments-count-dismissed")).toContainText("1");

      const { comments } = await apiGet<{
        comments: { body: string; status: string; reply: string | null; document_id: string }[];
      }>(request, `/kb/bases/${kb.id}/comments?document_id=${doc.id}&status=dismissed`);
      expect(comments).toHaveLength(1);
      expect(comments[0]?.reply).toBe("Step 2 is still right");

      // The knowledge base list shows document comments too, with a link to the document.
      await page.getByTestId("kb-row").filter({ hasText: kb.name }).click();
      await expect(kbComments.getByTestId("kb-comments-count-open")).toContainText("1");
      await expect(kbComments.getByTestId("kb-comments-count-dismissed")).toContainText("1");
      await kbComments.getByTestId("kb-comments-toggle").click();
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
      await openKbContext(page);
      await page.getByTestId("kb-comments-count-open").click();
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
        await openKbContext(page);
        await expect(page.getByTestId("kb-digest-summary")).toBeVisible();
        await page.getByTestId("kb-comments-count-open").click();
        await expect(page.getByTestId("kb-comment")).toHaveCount(1);
        await noHorizontalOverflow(page);
        await page.getByTestId("kb-digest-expand").click();
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
