import { expect, type Page, test } from "@playwright/test";
import { apiDelete, apiPatch, apiPost, gotoView, tid } from "./_helpers";

interface Task {
  id: string;
  status: string;
}

// @dnd-kit's PointerSensor has a 5px activation constraint, so real pointer
// moves must cross that threshold before the drag starts. Using page.mouse
// directly with intermediate steps reliably triggers onDragStart + onDragEnd.
async function dragCardTo(page: Page, taskId: string, targetStatus: string): Promise<void> {
  const card = page.locator(`[data-testid="kanban-card"][data-task-id="${taskId}"]`);
  const target = page.locator(
    `[data-testid="kanban-column"][data-column-status="${targetStatus}"]`,
  );

  // The kanban board scrolls horizontally when columns don't fit; make sure
  // we can actually see the card before trying to grab it.
  await card.scrollIntoViewIfNeeded();
  const cardBox = await card.boundingBox();
  if (!cardBox) throw new Error("card not in viewport after scroll");

  const from = { x: cardBox.x + cardBox.width / 2, y: cardBox.y + cardBox.height / 2 };

  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Cross dnd-kit PointerSensor activation threshold (5px)
  await page.mouse.move(from.x + 10, from.y + 10, { steps: 5 });

  const viewport = page.viewportSize();
  if (!viewport) throw new Error("no viewport");

  // Drive pointer toward the target. If the target is off-screen, park the
  // pointer near the viewport edge so dnd-kit's autoScroll brings it in, then
  // re-measure and continue. Caps the loop so a genuinely broken drop fails
  // fast instead of hanging the suite.
  let dropped = false;
  for (let i = 0; i < 30; i++) {
    const targetBox = await target.boundingBox();
    if (targetBox) {
      const centerX = targetBox.x + targetBox.width / 2;
      const inView = centerX >= 0 && centerX <= viewport.width;
      if (inView) {
        await page.mouse.move(centerX, targetBox.y + targetBox.height / 2, { steps: 10 });
        await page.mouse.up();
        dropped = true;
        break;
      }
      // Hold the pointer near the edge toward the target — dnd-kit autoScroll
      // only kicks in while an active drag pointer sits in the edge region.
      const edgeX = centerX < 0 ? 20 : viewport.width - 20;
      await page.mouse.move(edgeX, viewport.height / 2, { steps: 3 });
    }
    await page.waitForTimeout(250);
  }

  if (!dropped) {
    await page.mouse.up();
    throw new Error(`target column "${targetStatus}" never came into view during drag`);
  }
}

test.describe("Kanban drag & drop", () => {
  test.beforeEach(async ({ page }) => {
    await gotoView(page, "tasks");
    // Make sure we're in board view
    const boardBtn = page.getByTitle("Board view");
    if (await boardBtn.isVisible().catch(() => false)) await boardBtn.click();
  });

  test("valid drop (todo → doing) updates task status", async ({ page, request }) => {
    const title = tid("pw-kanban-valid");
    const task = await apiPost<Task>(request, "/tasks", {
      title,
      status: "todo",
      priority: "normal",
    });
    try {
      await page.reload();
      const card = page.locator(`[data-testid="kanban-card"][data-task-id="${task.id}"]`);
      await expect(card).toHaveAttribute("data-task-status", "todo");

      await dragCardTo(page, task.id, "doing");

      // Wait for PATCH to land and React Query to invalidate
      await expect
        .poll(
          async () => {
            const res = await request.get(
              `http://127.0.0.1:${process.env.ORC_API_PORT ?? "7721"}/api/tasks/${task.id}`,
            );
            if (!res.ok()) return null;
            return ((await res.json()) as Task).status;
          },
          { timeout: 10_000 },
        )
        .toBe("doing");
    } finally {
      await apiDelete(request, `/tasks/${task.id}`);
    }
  });

  test("free drag (done → doing) is allowed in Trello-like mode", async ({ page, request }) => {
    const title = tid("pw-kanban-free-drag");
    const task = await apiPost<Task>(request, "/tasks", {
      title,
      status: "todo",
      priority: "normal",
    });
    try {
      // Move to done via API, leaving the board showing 'done'
      await apiPatch<Task>(request, `/tasks/${task.id}`, { status: "doing" });
      await apiPatch<Task>(request, `/tasks/${task.id}`, { status: "review" });
      await apiPatch<Task>(request, `/tasks/${task.id}`, { status: "done" });

      await page.reload();
      const card = page.locator(`[data-testid="kanban-card"][data-task-id="${task.id}"]`);
      await expect(card).toHaveAttribute("data-task-status", "done");

      // Drag from done back to doing — this used to be forbidden, now it's allowed
      await dragCardTo(page, task.id, "doing");

      await expect
        .poll(
          async () => {
            const res = await request.get(
              `http://127.0.0.1:${process.env.ORC_API_PORT ?? "7721"}/api/tasks/${task.id}`,
            );
            if (!res.ok()) return null;
            return ((await res.json()) as Task).status;
          },
          { timeout: 10_000 },
        )
        .toBe("doing");
    } finally {
      await apiDelete(request, `/tasks/${task.id}`);
    }
  });

  test("clicking a card opens the task detail sheet", async ({ page, request }) => {
    const title = tid("pw-kanban-click");
    const task = await apiPost<Task>(request, "/tasks", {
      title,
      status: "todo",
      priority: "normal",
    });
    try {
      await page.reload();
      const card = page.locator(`[data-testid="kanban-card"][data-task-id="${task.id}"]`);
      await card.click();
      // Detail sheet is a dialog that shows the task title
      await expect(page.getByRole("dialog").getByText(title)).toBeVisible();
    } finally {
      await apiDelete(request, `/tasks/${task.id}`);
    }
  });
});
