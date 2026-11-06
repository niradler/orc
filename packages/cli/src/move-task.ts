import type { ImportResult } from "@orc/core/project-bundle";
import type { createOrcClient } from "@orc/sdk/client";

type Client = ReturnType<typeof createOrcClient>;

export type MoveTaskResult = ImportResult & {
  task_id: string;
  source_deleted: boolean;
  delete_error?: string;
};

export async function moveTask(input: {
  source: Client;
  destination: Client;
  taskId: string;
}): Promise<MoveTaskResult> {
  const exported = await input.source.transfer.exportTask(input.taskId);
  if (exported.error || !exported.data) throw new Error(exported.error?.error ?? "Export failed");
  const imported = await input.destination.transfer.importBundle(exported.data);
  if (imported.error || !imported.data) throw new Error(imported.error?.error ?? "Import failed");
  const removed = await input.source.tasks.delete(input.taskId);
  return {
    ...imported.data,
    task_id: exported.data.tasks[0]?.id ?? input.taskId,
    source_deleted: !removed.error,
    ...(removed.error ? { delete_error: removed.error.error } : {}),
  };
}
