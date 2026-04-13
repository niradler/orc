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
  const cardBox = await card.boundingBox();
  const targetBox = await target.boundingBox();
  if (!cardBox || !targetBox) throw new Error("card or target not in viewport");

  const from = { x: cardBox.x + cardBox.width / 2, y: cardBox.y + cardBox.height / 2 };
  const to = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 };

  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Cross activation threshold
  await page.mouse.move(from.x + 10, from.y + 10, { steps: 5 });
  // Glide to target
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
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
              `http://localhost:${process.env.ORC_API_PORT ?? "7721"}/tasks/${task.id}`,
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
              `http://localhost:${process.env.ORC_API_PORT ?? "7721"}/tasks/${task.id}`,
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
