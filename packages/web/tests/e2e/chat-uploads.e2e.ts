import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatThread } from "@orc/core/chat";
import { expect, test } from "@playwright/test";
import { openFinalFormStep, revealFormField } from "./_form-ui";
import { apiDelete, apiGet, apiPatch, apiPost, gotoView, tid } from "./_helpers";

test.beforeEach(async ({ page }) => {
  // Upload fixtures use mock chat; installed model-discovery processes must not
  // outlive the test and keep its temporary workspace open on Windows.
  await page.route("**/api/chat/models?**", (route) =>
    route.fulfill({ json: { models: [], warning: null } }),
  );
});

for (const width of [1440, 390]) {
  test(`file-only drafts stay reachable through session history at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await gotoView(page, "tasks");
    await page.goto("/tasks?project=all&chat=full");
    await page.getByTestId("chat-file-input").setInputFiles({
      name: "draft.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("keep this draft"),
    });
    const newSession = page.getByTestId("chat-history-new");
    if (!(await newSession.isVisible()))
      await page.getByTestId("chat-sessions-button").filter({ visible: true }).click();
    await newSession.click();
    await expect(page.getByTestId("chat-attachments")).toHaveCount(0);
    if (!(await page.getByTestId("chat-session-select").isVisible()))
      await page.getByTestId("chat-sessions-button").filter({ visible: true }).click();
    await page.getByTestId("chat-session-select").click();
    await expect(page.getByTestId("chat-attachments")).toContainText("draft.txt");
    await expect(page.getByTestId("chat-input")).toHaveValue("");
    await page.getByTestId("chat-remove-attachment").click();
  });
  test(`chat files upload to the workspace, persist in history and keep drafts at ${width}px`, async ({
    page,
    request,
  }, testInfo) => {
    const cwd = mkdtempSync(join(tmpdir(), "orc-web-uploads-"));
    const project = await apiPost<{ id: string }>(request, "/projects", {
      name: tid("uploads"),
      scope: cwd,
      upload_directory: "incoming",
    });
    try {
      await apiPatch(request, "/settings", { theme: "dark" });
      await page.setViewportSize({ width, height: 900 });
      await gotoView(page, "tasks");
      await page.goto(`/tasks?project=${project.id}&chat=full`);
      await page.getByTestId("chat-workspace-recent").click();
      await page.getByTestId("chat-workspace-cwd").fill(cwd);
      await page.getByTestId("chat-workspace-apply").click();
      await page.getByTestId("chat-input").fill("Read the uploaded report");
      let uploadRequests = 0;
      page.on("request", (req) => {
        if (req.url().endsWith("/chat/uploads")) uploadRequests++;
      });
      const bytes = Buffer.from([0, 255, 1, 10]);
      await page.getByTestId("chat-file-input").setInputFiles([
        { name: "report.bin", mimeType: "application/octet-stream", buffer: bytes },
        { name: "report.bin", mimeType: "application/octet-stream", buffer: Buffer.from("second") },
      ]);
      await expect(page.getByTestId("chat-attachments")).toContainText("report.bin");
      expect(uploadRequests).toBe(0);
      await expect(page.getByTestId("chat-input")).toHaveValue("Read the uploaded report");
      if (width < 640)
        expect(
          (await page.getByTestId("chat-attach-button").boundingBox())?.height,
        ).toBeGreaterThanOrEqual(44);
      await page.screenshot({ path: testInfo.outputPath(`uploads-staged-${width}.png`) });
      await page.getByTestId("chat-send-button").click();
      await expect(page.getByTestId("chat-panel")).toHaveAttribute("data-streaming", "false");
      await expect(page.getByTestId("chat-message-attachments")).toContainText("report.bin");
      expect(uploadRequests).toBe(1);
      const id = new URL(page.url()).searchParams.get("chatThread");
      const threads = await apiGet<Array<{ id: string }>>(request, "/chat/threads");
      const threadId = id || threads[0]?.id;
      const thread = await apiGet<ChatThread>(request, `/chat/threads/${threadId}`);
      const files = thread.messages[0]?.attachments ?? [];
      expect(files).toHaveLength(2);
      expect(files[0]?.path).toContain(join(cwd, "incoming", thread.id));
      expect(files[0]?.path).not.toBe(files[1]?.path);
      expect(readFileSync(files[0]?.path ?? "")).toEqual(bytes);
      await page.reload();
      await expect(page.getByTestId("chat-message-attachments")).toContainText("report.bin");
      await apiPatch(request, "/settings", { theme: "light" });
      await page.reload();
      await page.getByTestId("chat-file-input").setInputFiles({
        name: "follow-up.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("more data"),
      });
      await page.getByTestId("chat-send-button").click();
      await expect(page.getByTestId("chat-message-attachments")).toHaveCount(2);
      await expect(page.getByTestId("chat-panel")).toHaveAttribute("data-streaming", "false");
      await page.screenshot({ path: testInfo.outputPath(`uploads-history-light-${width}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    } finally {
      await page.goto("about:blank");
      await apiDelete(request, `/projects/${project.id}`);
      rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}

test("project upload directory saves, reopens and clears to the workspace default", async ({
  page,
  request,
}) => {
  const project = await apiPost<{ id: string }>(request, "/projects", {
    name: tid("upload-setting"),
  });
  try {
    await gotoView(page, "projects");
    const row = page.locator(`[data-testid="project-row"][data-project-id="${project.id}"]`);
    for (const value of ["incoming-files", ""]) {
      await row.click();
      const field = page.getByTestId("edit-project-upload-directory");
      await revealFormField(page, field);
      await field.fill(value);
      await openFinalFormStep(page);
      await page.getByTestId("edit-project-submit").click();
      await expect(page.getByTestId("edit-project-dialog")).toBeHidden();
      expect(
        (await apiGet<{ upload_directory: string | null }>(request, `/projects/${project.id}`))
          .upload_directory,
      ).toBe(value || null);
      await row.click();
      await revealFormField(page, field);
      await expect(field).toHaveValue(value);
      await page.keyboard.press("Escape");
    }
  } finally {
    await apiDelete(request, `/projects/${project.id}`);
  }
});

test("queued attachments remain bound to their message and can warn before losing a staged selection", async ({
  page,
  request,
}) => {
  const cwd = mkdtempSync(join(tmpdir(), "orc-upload-queue-"));
  try {
    await gotoView(page, "tasks");
    await page.goto("/tasks?chat=full");
    await page.getByTestId("chat-workspace-recent").click();
    await page.getByTestId("chat-workspace-cwd").fill(cwd);
    await page.getByTestId("chat-workspace-apply").click();
    await page.getByTestId("chat-input").fill("Respond after 1000ms");
    await page.getByTestId("chat-send-button").click();
    await expect(page.getByTestId("chat-panel")).toHaveAttribute("data-streaming", "true");
    await page.getByTestId("chat-file-input").setInputFiles({
      name: "queued.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("queued attachment"),
    });
    await page.getByTestId("chat-input").fill("Read the queued file");
    await page.getByTestId("chat-send-button").click();
    await expect(page.getByTestId("chat-message-attachments")).toContainText("queued.txt");
    await expect(page.getByTestId("chat-panel")).toHaveAttribute("data-streaming", "false");
    const threadId = new URL(page.url()).searchParams.get("chatThread");
    expect(threadId).not.toBeNull();
    const thread = await apiGet<ChatThread>(request, `/chat/threads/${threadId}`);
    const message = thread.messages.find((entry) => entry.attachments?.length);
    expect(message?.content).toBe("Read the queued file");
    expect(readFileSync(message?.attachments?.[0]?.path ?? "", "utf8")).toBe("queued attachment");
    await page
      .getByTestId("chat-file-input")
      .setInputFiles({ name: "staged.txt", mimeType: "text/plain", buffer: Buffer.from("staged") });
    const dialog = page.waitForEvent("dialog");
    const reload = page.reload();
    await (await dialog).dismiss();
    await reload.catch(() => {});
    await expect(page.getByTestId("chat-attachments")).toContainText("staged.txt");
    await page.getByRole("button", { name: "Remove staged.txt", exact: true }).click();
  } finally {
    await page.goto("about:blank");
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("oversized files preserve the draft and an admission error restores selected files", async ({
  page,
}) => {
  await gotoView(page, "tasks");
  await page.goto("/tasks?chat=full");
  await page.getByTestId("chat-input").fill("Keep my draft");
  await page.getByTestId("chat-file-input").setInputFiles({
    name: "too-large.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(20_000_001),
  });
  await expect(page.getByTestId("chat-panel")).toContainText("20 MB");
  await expect(page.getByTestId("chat-input")).toHaveValue("Keep my draft");
  await page
    .getByTestId("chat-file-input")
    .setInputFiles({ name: "keep.txt", mimeType: "text/plain", buffer: Buffer.from("keep") });
  await page.route("**/api/chat/uploads", (route) =>
    route.fulfill({ status: 400, json: { error: "Upload folder is not writable" } }),
  );
  await page.getByTestId("chat-send-button").click();
  await expect(page.getByTestId("chat-panel")).toContainText("Upload folder is not writable");
  await expect(page.getByTestId("chat-attachments")).toContainText("keep.txt");
});
