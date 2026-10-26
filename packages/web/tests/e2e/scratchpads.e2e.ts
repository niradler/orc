import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { LIVE_REGISTRY_DIR, writeRegistration } from "../../../core/src/live-session";
import {
  API_BASE,
  AUTH_HEADERS,
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  gotoView,
  tid,
} from "./_helpers";

interface Scratchpad {
  id: string;
  kind: "doc" | "diagram" | "html";
  title: string;
  content: string;
  revision: number;
  author: string;
  session_id: string | null;
  tags: string[];
}

const DIAGRAM = JSON.stringify({
  type: "excalidraw",
  version: 2,
  source: "orc-e2e",
  elements: [
    {
      id: "box",
      type: "rectangle",
      x: 100,
      y: 100,
      width: 200,
      height: 120,
      angle: 0,
      strokeColor: "#1e1e1e",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: 1,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: null,
      updated: 1,
      link: null,
      locked: false,
    },
    {
      id: "label",
      type: "text",
      x: 130,
      y: 140,
      width: 120,
      height: 25,
      angle: 0,
      strokeColor: "#1e1e1e",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: 2,
      version: 1,
      versionNonce: 2,
      isDeleted: false,
      boundElements: null,
      updated: 1,
      link: null,
      locked: false,
      text: "Hello pad",
      originalText: "Hello pad",
      fontSize: 20,
      fontFamily: 5,
      textAlign: "left",
      verticalAlign: "top",
      containerId: null,
      autoResize: true,
      lineHeight: 1.25,
    },
  ],
  appState: { viewBackgroundColor: "#ffffff" },
  files: {},
});

async function createPad(
  request: APIRequestContext,
  body: Partial<Scratchpad> & { kind: Scratchpad["kind"] },
): Promise<Scratchpad> {
  return apiPost<Scratchpad>(request, "/scratchpads", {
    title: tid("pw-pad"),
    author: "pw-agent",
    ...body,
  });
}

async function openPad(page: Page, id: string, search = ""): Promise<void> {
  // gotoView installs the API secret before the first load.
  await gotoView(page, "scratchpads");
  await page.goto(`/scratchpad/${id}${search}`);
  await expect(page.getByTestId("scratchpad-page")).toBeVisible();
}

function preview(page: Page) {
  return page.frameLocator('[data-testid="scratchpad-html-preview"]');
}

test.describe("Scratchpads", () => {
  test("create a doc from the UI, edit it, rename it and delete it", async ({ page, request }) => {
    const title = tid("pw-doc");
    let id: string | undefined;
    try {
      await gotoView(page, "scratchpads");
      await expect(page.getByTestId("view-title")).toHaveText("Scratchpads");
      await page.getByTestId("new-scratchpad-button").click();
      const form = page.getByTestId("scratchpad-form");
      await form.getByTestId("scratchpad-form-kind-doc").click();
      await form.getByTestId("scratchpad-form-title").fill(title);
      await form.getByTestId("scratchpad-form-submit").click();
      await expect(form).toHaveCount(0);

      // Creating opens the pad at its deep link.
      await expect(page).toHaveURL(/\/scratchpad\/[^/?]+/);
      id = new URL(page.url()).pathname.split("/").pop();
      await expect(page.getByTestId("scratchpad-title")).toHaveText(title);
      await expect(page.getByTestId("scratchpad-author")).toHaveText("human");

      await page.getByTestId("markdown-mode-split").click();
      await page.getByTestId("scratchpad-doc").fill("# Plan\n\nShip the scratchpad.\n");
      await expect(page.getByTestId("markdown-preview")).toContainText("Ship the scratchpad.");
      await page.getByTestId("document-save").click();
      await expect(page.getByTestId("document-save-status")).toHaveText("Saved");
      await expect
        .poll(async () => (await apiGet<Scratchpad>(request, `/scratchpads/${id}`)).content)
        .toContain("Ship the scratchpad.");

      await page.getByTestId("scratchpad-properties").click();
      await form.getByTestId("scratchpad-form-title").fill(`${title} renamed`);
      await form.getByTestId("scratchpad-form-submit").click();
      await expect(page.getByTestId("scratchpad-title")).toHaveText(`${title} renamed`);

      // The list finds it by title and opens it again.
      await gotoView(page, "scratchpads");
      await page.getByTestId("scratchpad-search-input").fill(`${title} renamed`);
      const row = page.locator(`[data-testid="scratchpad-row"][data-scratchpad-id="${id}"]`);
      await expect(row).toBeVisible();
      await row.click();
      await expect(page.getByTestId("scratchpad-title")).toHaveText(`${title} renamed`);

      await page.getByTestId("scratchpad-delete").click();
      await page.getByTestId("confirm-dialog-confirm").click();
      await expect(page).toHaveURL(/\/scratchpad(\?|$)/);
      const gone = await request.get(`${API_BASE}/scratchpads/${id}`, { headers: AUTH_HEADERS });
      expect(gone.status()).toBe(404);
      id = undefined;
    } finally {
      if (id) await apiDelete(request, `/scratchpads/${id}`);
    }
  });

  test("html pads run in an opaque-origin sandbox and save from the code view", async ({
    page,
    request,
  }) => {
    const pad = await createPad(request, {
      kind: "html",
      content:
        "<!doctype html><h1 id=out>static</h1><script>document.getElementById('out').textContent = 'scripted';</script>",
    });
    try {
      await openPad(page, pad.id);
      const frame = page.getByTestId("scratchpad-html-preview");
      await expect(frame).toHaveAttribute("sandbox", /allow-scripts/);
      await expect(frame).not.toHaveAttribute("sandbox", /allow-same-origin/);
      await expect(preview(page).locator("h1")).toHaveText("scripted");

      await page.getByTestId("scratchpad-view-split").click();
      await page.getByTestId("scratchpad-html-source").fill("<h1>edited by hand</h1>");
      await expect(page.getByTestId("scratchpad-save-status")).toHaveText("Unsaved changes");
      await expect(preview(page).locator("h1")).toHaveText("edited by hand");
      await page.getByTestId("scratchpad-save").click();
      await expect(page.getByTestId("scratchpad-save-status")).toHaveText("Saved");
      const saved = await apiGet<Scratchpad>(request, `/scratchpads/${pad.id}`);
      expect(saved.content).toBe("<h1>edited by hand</h1>");
      expect(saved.revision).toBe(pad.revision + 1);
      expect(saved.author).toBe("human");
    } finally {
      await apiDelete(request, `/scratchpads/${pad.id}`);
    }
  });

  test("rendering with ORC access is opt-in, keeps the secret out and an agent edit revokes it", async ({
    page,
    request,
  }) => {
    const probe = (label: string) =>
      `<!doctype html><h1 id=out>${label}</h1><script>const out = document.getElementById('out');` +
      "if (!window.orc) out.textContent = 'no access';" +
      "else { let storage = 'storage'; try { localStorage.length; } catch { storage = 'no storage'; }" +
      "orc.fetch('/scratchpads?limit=1').then(async (r) => { await r.json();" +
      "out.textContent = 'api ' + r.status + ' / ' + storage; }); }</script>";
    const pad = await createPad(request, { kind: "html", content: probe("v1") });
    try {
      await openPad(page, pad.id);
      await expect(preview(page).locator("h1")).toHaveText("no access");

      await page.getByTestId("scratchpad-html-trust").click();
      await page.getByTestId("confirm-dialog-cancel").click();
      await expect(preview(page).locator("h1")).toHaveText("no access");

      await page.getByTestId("scratchpad-html-trust").click();
      await page.getByTestId("confirm-dialog-confirm").click();
      // Access goes through the dashboard; the page itself stays in the opaque-origin sandbox.
      const frame = page.getByTestId("scratchpad-html-preview");
      await expect(frame).toHaveAttribute("data-trusted", "true");
      await expect(frame).not.toHaveAttribute("sandbox", /allow-same-origin/);
      await expect(preview(page).locator("h1")).toHaveText("api 200 / no storage");

      await page.getByTestId("scratchpad-html-sandbox").click();
      await expect(frame).not.toHaveAttribute("data-trusted");
      await expect(preview(page).locator("h1")).toHaveText("no access");

      // Saving your own edit keeps access.
      await page.getByTestId("scratchpad-html-trust").click();
      await page.getByTestId("confirm-dialog-confirm").click();
      await page.getByTestId("scratchpad-view-split").click();
      await page.getByTestId("scratchpad-html-source").fill(probe("mine"));
      await page.getByTestId("scratchpad-save").click();
      await expect(page.getByTestId("scratchpad-save-status")).toHaveText("Saved");
      await expect(page.getByTestId("scratchpad-html-sandbox")).toBeVisible();
      await expect(preview(page).locator("h1")).toHaveText("api 200 / no storage");

      // Access was given to the page the human saw, not to what another writer sends next,
      // even one that claims to be the human.
      await apiPatch(request, `/scratchpads/${pad.id}`, { content: probe("v2"), author: "human" });
      await expect(page.getByTestId("scratchpad-html-trust")).toBeVisible();
      await expect(frame).not.toHaveAttribute("data-trusted");
      await expect(preview(page).locator("h1")).toHaveText("no access");
    } finally {
      await apiDelete(request, `/scratchpads/${pad.id}`);
    }
  });

  test("an agent edit refreshes a clean pad and conflicts with a dirty draft", async ({
    page,
    request,
  }) => {
    const pad = await createPad(request, { kind: "html", content: "<p>v1</p>" });
    try {
      await openPad(page, pad.id, "?padView=split");
      await expect(preview(page).locator("p")).toHaveText("v1");

      // Clean: the agent's write shows up without a reload.
      await apiPatch(request, `/scratchpads/${pad.id}`, {
        content: "<p>v2</p>",
        author: "pw-agent",
      });
      await expect(preview(page).locator("p")).toHaveText("v2");

      // Dirty: the draft is kept and saving reports the conflict instead of overwriting.
      await page.getByTestId("scratchpad-html-source").fill("<p>mine</p>");
      await apiPatch(request, `/scratchpads/${pad.id}`, {
        content: "<p>v3</p>",
        author: "pw-agent",
      });
      await expect(page.getByText("This scratchpad changed elsewhere.")).toBeVisible();
      await page.getByTestId("scratchpad-save").click();
      await expect(page.getByText("Your draft has been kept.")).toBeVisible();
      expect((await apiGet<Scratchpad>(request, `/scratchpads/${pad.id}`)).content).toBe(
        "<p>v3</p>",
      );
      await expect(page.getByTestId("scratchpad-html-source")).toContainText("<p>mine</p>");

      await page.getByTestId("scratchpad-discard").click();
      await expect(page.getByTestId("scratchpad-save-status")).toHaveText("Saved");
      await expect(preview(page).locator("p")).toHaveText("v3");

      // A rename or tag change does not touch the file, so an open draft still saves.
      await page.getByTestId("scratchpad-html-source").fill("<p>after rename</p>");
      await apiPatch(request, `/scratchpads/${pad.id}`, { tags: ["renamed"], author: "pw-agent" });
      await expect(page.getByTestId("scratchpad-overwrite")).toBeHidden();
      await page.getByTestId("scratchpad-save").click();
      await expect(page.getByTestId("scratchpad-save-status")).toHaveText("Saved");
      expect((await apiGet<Scratchpad>(request, `/scratchpads/${pad.id}`)).content).toBe(
        "<p>after rename</p>",
      );

      // A real conflict can also be resolved in favour of the draft.
      await page.getByTestId("scratchpad-html-source").fill("<p>keep me</p>");
      await apiPatch(request, `/scratchpads/${pad.id}`, {
        content: "<p>v4</p>",
        author: "pw-agent",
      });
      await page.getByTestId("scratchpad-overwrite").click();
      await page.getByTestId("scratchpad-save").click();
      await expect(page.getByTestId("scratchpad-save-status")).toHaveText("Saved");
      expect((await apiGet<Scratchpad>(request, `/scratchpads/${pad.id}`)).content).toBe(
        "<p>keep me</p>",
      );
    } finally {
      await apiDelete(request, `/scratchpads/${pad.id}`);
    }
  });

  test("diagrams open in Excalidraw with same-origin fonts and export images", async ({
    page,
    request,
  }) => {
    const requests: string[] = [];
    page.on("request", (req) => requests.push(req.url()));
    const pad = await createPad(request, { kind: "diagram", content: DIAGRAM });
    try {
      await openPad(page, pad.id);
      const canvas = page.getByTestId("scratchpad-canvas");
      await expect(canvas.locator("canvas").first()).toBeVisible({ timeout: 20_000 });
      // Loading normalizes the scene; that alone must not mark the pad dirty.
      const status = page.getByTestId("scratchpad-save-status");
      await expect(status).toHaveText("Saved");
      // Panning and selecting are not edits.
      const box = await canvas.boundingBox();
      if (!box) throw new Error("Canvas has no bounds");
      await page.mouse.click(box.x + box.width / 2 - 200, box.y + 150);
      await expect(status).toHaveText("Saved");

      // Draw a rectangle, undo it back to the loaded file, then draw again and save.
      const draw = async () => {
        await page.keyboard.press("r");
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 80, {
          steps: 5,
        });
        await page.mouse.up();
      };
      await draw();
      await expect(status).toHaveText("Unsaved changes");
      await page.keyboard.press("Control+z");
      await expect(status).toHaveText("Saved");
      await draw();
      await expect(status).toHaveText("Unsaved changes");
      await page.getByTestId("scratchpad-save").click();
      await expect(status).toHaveText("Saved");
      const saved = await apiGet<Scratchpad>(request, `/scratchpads/${pad.id}`);
      expect(saved.revision).toBe(pad.revision + 1);
      expect(
        (JSON.parse(saved.content) as { elements: { isDeleted?: boolean }[] }).elements.filter(
          (element) => !element.isDeleted,
        ),
      ).toHaveLength(3);

      const download = page.waitForEvent("download");
      await page.getByTestId("scratchpad-export-svg").click();
      expect((await download).suggestedFilename()).toMatch(/\.svg$/);

      const fonts = requests.filter((url) => url.includes("/assets/excalidraw/fonts/"));
      expect(fonts.length).toBeGreaterThan(0);
      for (const font of fonts) expect(new URL(font).origin).toBe(new URL(page.url()).origin);
      expect(requests.some((url) => url.includes("esm.sh"))).toBe(false);
    } finally {
      await apiDelete(request, `/scratchpads/${pad.id}`);
    }
  });

  test("properties link a pad to an existing session and back to no session", async ({
    page,
    request,
  }) => {
    const externalId = tid("pw-pad-session");
    const transcriptPath = join(LIVE_REGISTRY_DIR, `${externalId}.jsonl`);
    mkdirSync(LIVE_REGISTRY_DIR, { recursive: true });
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "hi" }] } })}\n`,
    );
    writeRegistration({
      backend: "claude",
      externalId,
      pid: process.pid,
      title: `${externalId} title`,
      status: "idle",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      transcriptPath,
    });
    await apiPost(request, "/sessions/live/sync", {});
    const pad = await createPad(request, { kind: "doc", content: "# Linked" });
    try {
      await openPad(page, pad.id);
      await page.getByTestId("scratchpad-properties").click();
      const form = page.getByTestId("scratchpad-form");
      await form.getByTestId("scratchpad-form-session").click();
      await page
        .getByTestId("scratchpad-form-session-option")
        .filter({ hasText: `${externalId} title` })
        .click();
      await form.getByTestId("scratchpad-form-submit").click();
      await expect(form).toHaveCount(0);
      await expect
        .poll(async () => (await apiGet<Scratchpad>(request, `/scratchpads/${pad.id}`)).session_id)
        .toBe(externalId);

      await page.getByTestId("scratchpad-properties").click();
      await form.getByTestId("scratchpad-form-session").click();
      await page.getByRole("option", { name: "No session" }).click();
      await form.getByTestId("scratchpad-form-submit").click();
      await expect(form).toHaveCount(0);
      await expect
        .poll(async () => (await apiGet<Scratchpad>(request, `/scratchpads/${pad.id}`)).session_id)
        .toBeNull();
    } finally {
      await apiDelete(request, `/scratchpads/${pad.id}`);
      rmSync(join(LIVE_REGISTRY_DIR, `claude-${externalId}.json`), { force: true });
      rmSync(transcriptPath, { force: true });
    }
  });

  test("full screen fills the window, keeps dialogs on top and leaves with Escape", async ({
    page,
    request,
  }) => {
    const pad = await createPad(request, { kind: "html", content: "<h1>big</h1>" });
    try {
      await openPad(page, pad.id);
      const stage = page.getByTestId("scratchpad-stage");
      await page.getByTestId("scratchpad-fullscreen").click();
      await expect(stage).toHaveAttribute("data-fullscreen", "true");
      const viewport = page.viewportSize();
      const frame = await page.getByTestId("scratchpad-html-preview").boundingBox();
      expect(frame?.height).toBeGreaterThan((viewport?.height ?? 0) * 0.75);

      // The access dialog opens over full screen, and its Escape closes only the dialog.
      await page.getByTestId("scratchpad-html-trust").click();
      await expect(page.getByTestId("confirm-dialog-confirm")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("confirm-dialog-confirm")).toHaveCount(0);
      await expect(stage).toHaveAttribute("data-fullscreen", "true");

      await page.keyboard.press("Escape");
      await expect(stage).not.toHaveAttribute("data-fullscreen");
      await page.getByTestId("scratchpad-fullscreen").click();
      await page.getByTestId("scratchpad-exit-fullscreen").click();
      await expect(stage).not.toHaveAttribute("data-fullscreen");
    } finally {
      await apiDelete(request, `/scratchpads/${pad.id}`);
    }
  });

  test("the command palette opens the new scratchpad dialog", async ({ page }) => {
    await gotoView(page, "dashboard");
    await page.getByTestId("command-palette-open").click();
    await page.getByTestId("command-palette-input").fill("new scratchpad");
    await page.locator('[data-command-id="new-scratchpad"]').click();
    await expect(page).toHaveURL(/\/scratchpad(\?|$)/);
    await expect(page.getByTestId("scratchpad-form")).toBeVisible();
    expect(new URL(page.url()).searchParams.has("new")).toBe(false);
  });
});
