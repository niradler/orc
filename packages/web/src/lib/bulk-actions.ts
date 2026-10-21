export type BulkActionResult = {
  succeeded: string[];
  failed: { id: string; error: string }[];
};

export async function applyBulkAction(
  ids: string[],
  perform: (id: string) => Promise<unknown>,
): Promise<BulkActionResult> {
  const succeeded: string[] = [];
  const failed: BulkActionResult["failed"] = [];
  for (const id of [...new Set(ids)]) {
    try {
      await perform(id);
      succeeded.push(id);
    } catch (error) {
      failed.push({ id, error: error instanceof Error ? error.message : "Update failed" });
    }
  }
  return { succeeded, failed };
}
