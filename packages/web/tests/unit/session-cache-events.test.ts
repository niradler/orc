import { afterEach, expect, jest, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { flushResourceChanges, invalidateResources } from "../../src/lib/resource-events";
import { sessionCacheQuery } from "../../src/lib/session-cache";

afterEach(() => {
  jest.useRealTimers();
});

async function publish(client: QueryClient, resources: Parameters<typeof invalidateResources>[1]) {
  const refreshed = invalidateResources(client, resources);
  await flushResourceChanges(client);
  await refreshed;
}

test("live context meter stays idle over time and refreshes on a usage event", async () => {
  const query = sessionCacheQuery("native-1", true);
  expect(query.refetchInterval).toBeUndefined();
  jest.useFakeTimers();
  const client = new QueryClient();
  let reads = 0;
  let input = 100;
  const observer = new QueryObserver(client, {
    ...query,
    queryFn: async () => {
      reads++;
      return { latest: { input_tokens: input } };
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    await observer.refetch();
    expect(reads).toBe(1);
    jest.advanceTimersByTime(120_000);
    await Promise.resolve();
    expect(reads).toBe(1);
    await publish(client, ["sessions", "session-messages"]);
    expect(reads).toBe(1);
    input = 250;
    await publish(client, ["usage"]);
    expect(reads).toBe(2);
    expect(observer.getCurrentResult().data).toEqual({ latest: { input_tokens: 250 } });
  } finally {
    unsubscribe();
    client.clear();
  }
});

test("missing session id keeps the meter query disabled", () => {
  expect(sessionCacheQuery(null, true).enabled).toBe(false);
  expect(sessionCacheQuery(undefined, false).queryKey).toEqual(["session-cache", "", false]);
});
