export type Versioned = { id: string; version: string };

/**
 * Keeps the snapshot's rows and order while the user works the list. `present` says whether a
 * snapshot row still exists; `pending` counts the rows the live order would add, move or drop.
 */
export function stableOrder(
  snapshot: readonly Versioned[],
  live: readonly Versioned[],
  present: (id: string) => boolean,
): { order: string[]; pending: number } {
  const order = snapshot.filter((item) => present(item.id)).map((item) => item.id);
  const liveIds = live.map((item) => item.id);
  if (order.length === liveIds.length && order.every((id, index) => id === liveIds[index]))
    return { order, pending: 0 };
  const before = new Map(snapshot.map((item) => [item.id, item.version]));
  const liveSet = new Set(liveIds);
  let changed = live.filter((item) => before.get(item.id) !== item.version).length;
  changed += order.filter((id) => !liveSet.has(id)).length;
  return { order, pending: Math.max(1, changed) };
}
