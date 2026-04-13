import { describe, expect, test } from "bun:test";
import { createOrcClient } from "./client.js";

describe("createOrcClient", () => {
  const client = createOrcClient({ baseUrl: "http://localhost:0", secret: "test" });

  test("exposes resource namespaces", () => {
    expect(typeof client.tasks.list).toBe("function");
    expect(typeof client.memories.list).toBe("function");
    expect(typeof client.jobs.list).toBe("function");
    expect(typeof client.skills.list).toBe("function");
    expect(typeof client.projects.list).toBe("function");
    expect(typeof client.sessions.list).toBe("function");
    expect(typeof client.tags.list).toBe("function");
    expect(typeof client.health.check).toBe("function");
    expect(typeof client.gateway.status).toBe("function");
    expect(typeof client.knowledge.search).toBe("function");
  });

  test("returns network error when the API is unreachable", async () => {
    const result = await client.health.check();
    expect(result.data).toBeNull();
    expect(result.error?.code).toBe("NETWORK_ERROR");
  });
});
