import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { API_BASE, AUTH_HEADERS, apiDelete, apiGet, apiPost, gotoView, tid } from "./_helpers";

type Kb = { id: string; name: string };
type Doc = { id: string; revision: number; title: string };

async function createKb(request: Parameters<typeof apiPost>[0], name: string): Promise<Kb> {
  return apiPost<Kb>(request, "/kb/bases", { name, project_id: null });
}

async function openKb(page: Page, name: string): Promise<void> {
  await gotoView(page, "knowledge");
  await page.locator(`[data-testid="kb-row"][data-kb-name="${name}"]`).click();
  await expect(page.getByTestId("kb-overview-name")).toHaveText(name);
}

const docRow = (page: Page, title: string) =>
  page.locator(`[data-testid="kb-document-row"][data-document-title="${title}"]`);

test.describe("Knowledge bases", () => {
  test("create a knowledge base, write a document, search it and delete the base", async ({
    page,
  }) => {
    const name = tid("pw-kb");
    await gotoView(page, "knowledge");
    await expect(page.getByTestId("view-title")).toHaveText("Knowledge bases");
    await page.getByTestId("kb-create").click();
    await page.getByTestId("kb-name-input").fill(name);
    await page.getByTestId("kb-create-submit").click();
    await expect(page.getByTestId("kb-overview-name")).toHaveText(name);
    await expect(page.locator(`[data-testid="kb-row"][data-kb-name="${name}"]`)).toHaveAttribute(
      "aria-current",
      "true",
    );

    await page.getByTestId("kb-new-document").click();
    await page.getByTestId("kb-doc-title-input").fill("Deploy runbook");
    await page.getByTestId("kb-doc-labels-input").fill("ops, runbook");
    await page.getByTestId("kb-doc-create-submit").click();
    await expect(page.getByTestId("kb-document-title")).toHaveText("Deploy runbook");
    expect(new URL(page.url()).searchParams.get("editorMode")).toBe("edit");
    await page
      .getByTestId("kb-document-content")
      .fill("# Deploy runbook\n\n## Rollback\n\nRun kbrollbackneedle to roll back.");
    await page.getByTestId("document-save").click();
    await expect(page.getByTestId("document-save-status")).toHaveText("Saved");
    await expect(page.getByTestId("kb-revision")).toHaveCount(2);
    await expect(page.getByTestId("kb-document-label")).toHaveText(["ops", "runbook"]);

    // The editor state is shareable: reload keeps the document and mode.
    await page.reload();
    await expect(page.getByTestId("kb-document-content")).toContainText("kbrollbackneedle");

    await page.getByTestId("kb-search-input").fill("kbrollbackneedle");
    await page.getByTestId("kb-search-submit").click();
    await expect(page).toHaveURL(/q=kbrollbackneedle/);
    const result = page.getByTestId("kb-search-result").first();
    await expect(result).toContainText("Deploy runbook");
    await expect(result.getByTestId("kb-search-passage").first()).toContainText("Rollback");
    await expect(result.locator("mark").first()).toHaveText("kbrollbackneedle");
    await expect(result.getByTestId("kb-citation").first()).toHaveText(/^kb:/);
    await page.getByTestId("kb-search-passage").first().click();
    await expect(page.getByTestId("kb-document-title")).toHaveText("Deploy runbook");
    await page.goBack();
    await expect(page.getByTestId("kb-search-results")).toBeVisible();
    // The search ran with the document open, so clearing it returns to that document.
    await page.getByTestId("kb-search-clear").click();
    await expect(page.getByTestId("kb-document-title")).toHaveText("Deploy runbook");

    await page.getByTestId("kb-settings").click();
    await page.getByTestId("kb-delete").click();
    await page.getByTestId("confirm-dialog-confirm").click();
    await expect(page.locator(`[data-testid="kb-row"][data-kb-name="${name}"]`)).toHaveCount(0);
  });

  test("upload several files with progress, filter by folder and label, and open parsed text", async ({
    page,
    request,
  }) => {
    const kb = await createKb(request, tid("pw-kb-upload"));
    try {
      await openKb(page, kb.name);
      await page.getByTestId("kb-upload-input").setInputFiles([
        {
          name: "notes.md",
          mimeType: "text/markdown",
          buffer: Buffer.from("# Notes\n\nmdupload body"),
        },
        { name: "plain.txt", mimeType: "text/plain", buffer: Buffer.from("plain text upload") },
        {
          name: "people.csv",
          mimeType: "text/csv",
          buffer: Buffer.from("name,role\nAda,engineer\nGrace,admiral\n"),
        },
        {
          name: "page.html",
          mimeType: "text/html",
          buffer: Buffer.from("<h1>Html page</h1><p>htmluploadneedle paragraph</p>"),
        },
      ]);
      const items = page.getByTestId("kb-upload-item");
      await expect(items).toHaveCount(4);
      await expect(page.locator('[data-testid="kb-upload-item"][data-status="done"]')).toHaveCount(
        4,
      );
      await page.getByTestId("kb-upload-clear").click();
      await expect(items).toHaveCount(0);

      // Non-Markdown uploads are parsed in the background, then become searchable text.
      await docRow(page, "people").click();
      await expect(page.getByTestId("kb-document-content")).toContainText("Grace", {
        timeout: 30_000,
      });
      await expect(page.getByTestId("kb-parse-state")).toHaveCount(0);
      await expect(page.getByTestId("kb-doc-download")).toBeVisible();
      await expect(page.getByTestId("kb-doc-reparse")).toBeVisible();

      await docRow(page, "page").click();
      await expect(page.getByTestId("kb-document-content")).toContainText("htmluploadneedle", {
        timeout: 30_000,
      });

      // Folders and labels come from document metadata.
      const notes = await apiGet<{ documents: (Doc & { path: string })[] }>(
        request,
        `/kb/bases/${kb.id}/documents`,
      ).then((l) => l.documents.find((d) => d.title === "Notes"));
      expect(notes).toBeTruthy();
      const res = await request.patch(`${API_BASE}/kb/documents/${notes?.id}`, {
        headers: AUTH_HEADERS,
        data: { expected_revision: notes?.revision, path: "guides/notes.md", labels: ["guide"] },
      });
      expect(res.ok()).toBe(true);
      await page.reload();
      await page.locator('[data-testid="kb-folder"][data-folder="guides"]').click();
      await expect(page).toHaveURL(/folder=guides/);
      await expect(page.getByTestId("kb-document-row")).toHaveCount(1);
      await expect(docRow(page, "Notes")).toBeVisible();
      await page.locator('[data-testid="kb-folder"][data-folder="guides"]').click();
      await expect(page.getByTestId("kb-document-row")).toHaveCount(4);
      await page.getByTestId("kb-label-filter").filter({ hasText: "guide" }).click();
      await expect(page.getByTestId("kb-document-row")).toHaveCount(1);
    } finally {
      await apiDelete(request, `/kb/bases/${kb.id}`);
    }
  });

  test("document links resolve between documents and show backlinks", async ({ page, request }) => {
    const kb = await createKb(request, tid("pw-kb-links"));
    try {
      await apiPost(request, `/kb/bases/${kb.id}/documents`, {
        title: "Architecture",
        content: "# Architecture\n\nSee [[Glossary]] and [[Missing page]].",
      });
      await apiPost(request, `/kb/bases/${kb.id}/documents`, {
        title: "Glossary",
        content: "# Glossary\n\nTerms.",
      });
      await openKb(page, kb.name);
      await docRow(page, "Architecture").click();
      await expect(page.getByTestId("kb-unresolved-link")).toContainText(/missing page/i);
      await page.getByTestId("kb-outgoing-link").filter({ hasText: "Glossary" }).click();
      await expect(page.getByTestId("kb-document-title")).toHaveText("Glossary");
      await expect(page.getByTestId("kb-backlink")).toContainText("Architecture");
      await page.getByTestId("kb-backlink").click();
      await expect(page.getByTestId("kb-document-title")).toHaveText("Architecture");
      // The link inside the rendered Markdown navigates too.
      await page.getByTestId("wiki-link-glossary").click();
      await expect(page.getByTestId("kb-document-title")).toHaveText("Glossary");
    } finally {
      await apiDelete(request, `/kb/bases/${kb.id}`);
    }
  });

  test("reads are counted by source and shown per document", async ({ page, request }) => {
    const kb = await createKb(request, tid("pw-kb-usage"));
    try {
      const doc = await apiPost<Doc>(request, `/kb/bases/${kb.id}/documents`, {
        title: "Usage target",
        content: "# Usage target",
      });
      for (const source of ["mcp", "mcp", "cli"]) {
        const res = await request.get(`${API_BASE}/kb/documents/${doc.id}`, {
          headers: { ...AUTH_HEADERS, "X-Orc-Source": source },
        });
        expect(res.ok()).toBe(true);
      }
      await openKb(page, kb.name);
      await docRow(page, "Usage target").click();
      const usage = page.getByTestId("kb-doc-usage");
      await expect(usage.getByTestId("kb-doc-usage-mcp").locator("td").nth(1)).toHaveText("2");
      await expect(usage.getByTestId("kb-doc-usage-cli").locator("td").nth(1)).toHaveText("1");
      // Opening it here is itself a UI read.
      await expect(usage.getByTestId("kb-doc-usage-ui").locator("td").nth(1)).not.toHaveText("0");
      await page.getByTestId("kb-row").filter({ hasText: kb.name }).click();
      await expect(page.getByTestId("kb-usage-reads")).not.toHaveText("0");
    } finally {
      await apiDelete(request, `/kb/bases/${kb.id}`);
    }
  });

  test("a concurrent edit is a conflict that keeps the draft until discarded", async ({
    page,
    request,
  }) => {
    const kb = await createKb(request, tid("pw-kb-conflict"));
    try {
      const doc = await apiPost<Doc>(request, `/kb/bases/${kb.id}/documents`, {
        title: "Shared page",
        content: "# Shared page\n\nOriginal.",
      });
      await openKb(page, kb.name);
      await docRow(page, "Shared page").click();
      await page.getByTestId("markdown-mode-edit").click();
      await page.getByTestId("kb-document-content").fill("# My unsaved draft");
      const res = await request.patch(`${API_BASE}/kb/documents/${doc.id}`, {
        headers: AUTH_HEADERS,
        data: { expected_revision: doc.revision, content: "# Other writer's version" },
      });
      expect(res.ok()).toBe(true);
      // A refetch landing first must not let the draft overwrite the other writer.
      await page.getByTestId("kb-details-toggle").click();
      await page.getByTestId("kb-details-toggle").click();
      await page.getByTestId("document-save").click();
      await expect(page.getByTestId("document-workspace").getByRole("alert")).toBeVisible();
      await expect(page.getByTestId("kb-document-content")).toContainText("My unsaved draft");
      page.once("dialog", (dialog) => dialog.accept());
      await page.getByTestId("document-discard").click();
      await expect(page.getByTestId("kb-document-content")).toContainText("Other writer's version");
      await page.getByTestId("kb-document-content").fill("# Resolved");
      await page.getByTestId("document-save").click();
      await expect(page.getByTestId("document-save-status")).toHaveText("Saved");
      const saved = await apiGet<{ content: string }>(request, `/kb/documents/${doc.id}`);
      expect(saved.content).toBe("# Resolved");
    } finally {
      await apiDelete(request, `/kb/bases/${kb.id}`);
    }
  });

  test("a registered folder is copied in, follows the file until edited and is never written", async ({
    page,
    request,
  }) => {
    const kb = await createKb(request, tid("pw-kb-folder"));
    // A private directory, not the shared OS tmp dir, which can hold unreadable entries.
    const directory = mkdtempSync(join(tmpdir(), "orc-pw-kb-source-"));
    const file = join(directory, "Read Me.md");
    const original = "# Folder doc\n\nkbfoldersourceneedle evidence.";
    writeFileSync(file, original);
    try {
      await openKb(page, kb.name);
      await page.getByTestId("kb-sources").click();
      await page.getByTestId("kb-source-path-input").fill(directory);
      await page.getByTestId("kb-source-add").click();
      await expect(page.getByTestId("kb-source-row")).toHaveCount(1);
      await expect(page.getByTestId("kb-source-result")).toContainText("1 added");
      await page.keyboard.press("Escape");
      await expect(docRow(page, "Folder doc")).toBeVisible();

      await page.getByTestId("kb-search-input").fill("kbfoldersourceneedle");
      await page.getByTestId("kb-search-submit").click();
      await page.getByTestId("kb-search-passage").first().click();
      await expect(page.getByTestId("kb-folder-sync")).toHaveText("Follows folder file");

      // A change to the file reaches the copy on the next scan.
      writeFileSync(file, "# Folder doc\n\nkbfolderchanged on disk.");
      await page.getByTestId("kb-sources").click();
      await page.getByTestId("kb-source-scan").click();
      await expect(page.getByTestId("kb-source-result")).toContainText("1 updated");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("kb-document-content")).toContainText("kbfolderchanged");

      // Editing in ORC detaches the copy; the folder file is untouched and later scans skip it.
      await page.getByTestId("markdown-mode-edit").click();
      const edited = "# Folder doc\n\nkbfoldersaved in ORC.";
      await page.getByTestId("kb-document-content").fill(edited);
      await page.getByTestId("document-save").click();
      await expect(page.getByTestId("document-save-status")).toHaveText("Saved");
      await expect(page.getByTestId("kb-folder-sync")).toHaveText("Edited, no longer synced");
      expect(readFileSync(file, "utf8")).toBe("# Folder doc\n\nkbfolderchanged on disk.");
      writeFileSync(file, "# Folder doc\n\nlater disk change.");
      await page.getByTestId("kb-sources").click();
      await page.getByTestId("kb-source-scan").click();
      await expect(page.getByTestId("kb-source-result")).toContainText("0 updated");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("kb-document-content")).toContainText("kbfoldersaved in ORC");
    } finally {
      await apiDelete(request, `/kb/bases/${kb.id}`);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("remote images in a document render as links and are never requested", async ({
    page,
    request,
  }) => {
    const kb = await createKb(request, tid("pw-kb-image"));
    const requested: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("tracker.invalid")) requested.push(req.url());
    });
    try {
      await apiPost<Doc>(request, `/kb/bases/${kb.id}/documents`, {
        title: "Pixel page",
        content: "# Pixel page\n\n![status chart](https://tracker.invalid/pixel.gif?u=1)\n\nBody.",
      });
      await openKb(page, kb.name);
      await docRow(page, "Pixel page").click();
      const link = page.getByTestId("markdown-remote-image");
      await expect(link).toHaveText("status chart");
      await expect(link).toHaveAttribute("href", "https://tracker.invalid/pixel.gif?u=1");
      await expect(page.getByTestId("kb-document").locator("img")).toHaveCount(0);
      expect(requested).toEqual([]);
    } finally {
      await apiDelete(request, `/kb/bases/${kb.id}`);
    }
  });

  test("editable-by settings decide which sources may change documents", async ({
    page,
    request,
  }) => {
    const kb = await createKb(request, tid("pw-kb-editable"));
    try {
      const doc = await apiPost<Doc>(request, `/kb/bases/${kb.id}/documents`, {
        title: "Guarded",
        content: "# Guarded",
      });
      await openKb(page, kb.name);
      await expect(page.getByTestId("kb-overview")).toContainText(
        "editable from mcp, api, cli, ui",
      );
      await page.getByTestId("kb-settings").click();
      await page.getByTestId("kb-editable-mcp").uncheck();
      await page.getByTestId("kb-editable-cli").uncheck();
      await page.getByTestId("kb-settings-save").click();
      await expect(page.getByTestId("kb-overview")).toContainText("editable from api, ui");

      const fromMcp = await request.patch(`${API_BASE}/kb/documents/${doc.id}`, {
        headers: { ...AUTH_HEADERS, "X-Orc-Source": "mcp" },
        data: { expected_revision: doc.revision, content: "# Agent change" },
      });
      expect(fromMcp.status()).toBe(403);
      const fromApi = await request.patch(`${API_BASE}/kb/documents/${doc.id}`, {
        headers: AUTH_HEADERS,
        data: { expected_revision: doc.revision, content: "# API change" },
      });
      expect(fromApi.ok()).toBe(true);
      // MCP may not widen its own access either.
      const widen = await request.patch(`${API_BASE}/kb/bases/${kb.id}`, {
        headers: { ...AUTH_HEADERS, "X-Orc-Source": "mcp" },
        data: { editable_by: ["mcp"] },
      });
      expect(widen.status()).toBe(403);
    } finally {
      await apiDelete(request, `/kb/bases/${kb.id}`);
    }
  });
});

test("Settings shows the knowledge parsers, optional Docling and embedding provider", async ({
  page,
  request,
}) => {
  await gotoView(page, "settings");
  const section = page.getByTestId("settings-knowledge");
  await expect(section).toBeVisible();
  await expect(section.getByTestId("settings-parser-basic")).toContainText("Formats");
  const docling = section.getByTestId("settings-parser-docling");
  await expect(docling).toContainText(/OCR/i);
  await expect(docling.getByTestId("settings-docling-install")).toContainText("GB");
  await expect(section.getByTestId("settings-kb-parser")).toContainText(/automatic/i);
  await section.getByTestId("settings-kb-provider").click();
  await page.getByRole("option", { name: "Ollama" }).click();
  await expect(section.getByTestId("settings-kb-model")).toBeVisible();
  // The token is write-only: saved encrypted, reported only as set.
  await section.getByTestId("settings-kb-base-url").fill("http://127.0.0.1:9");
  await section.getByTestId("settings-kb-api-key").fill("pw-secret-token");
  await section.getByTestId("settings-knowledge-save").click();
  await expect(section.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  const saved = await apiGet<{ embedding: Record<string, unknown> }>(request, "/kb/settings");
  expect(saved.embedding.api_key_set).toBe(true);
  expect(JSON.stringify(saved)).not.toContain("pw-secret-token");
  await expect(section.getByTestId("settings-kb-api-key")).toHaveValue("");
  await expect(section.getByTestId("settings-kb-api-key")).toHaveAttribute("placeholder", /Saved/);
  await section.getByTestId("settings-kb-api-key-clear").check();
  await section.getByTestId("settings-kb-base-url").fill("");
  await section.getByTestId("settings-kb-provider").click();
  await page.getByRole("option", { name: "None" }).click();
  await section.getByTestId("settings-knowledge-save").click();
  await expect(section.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  const cleared = await apiGet<{ embedding: Record<string, unknown> }>(request, "/kb/settings");
  expect(cleared.embedding).toMatchObject({ provider: "none", api_key_set: false });
});
