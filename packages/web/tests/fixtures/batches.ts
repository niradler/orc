export async function inFixtureBatches<T>(
  items: readonly T[],
  operation: (item: T) => Promise<unknown>,
): Promise<void> {
  const failures: unknown[] = [];
  for (let offset = 0; offset < items.length; offset += 10) {
    const results = await Promise.allSettled(
      items.slice(offset, offset + 10).map(async (item) => operation(item)),
    );
    for (const result of results) if (result.status === "rejected") failures.push(result.reason);
  }
  if (failures.length) throw new AggregateError(failures, "Fixture operations failed");
}
