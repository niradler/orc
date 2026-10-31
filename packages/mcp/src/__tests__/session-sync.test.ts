import { expect, test } from "bun:test";
import { executeTool } from "../tools.js";

test("HTTP MCP returns sync capabilities on its client-facing origin", async () => {
  const token = "a".repeat(43);
  const previous = process.env.ORC_API_BASE;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      expect(new URL(request.url).pathname).toBe("/api/sessions/archive/sync");
      return Response.json({
        sync_url: new URL(`/api/session-sync/${token}`, request.url).toString(),
        expires_at: "2026-12-01T00:00:00.000Z",
        projects: [{ id: "p1", name: "Project A", git_remote_url: null }],
      });
    },
  });
  process.env.ORC_API_BASE = server.url.toString().replace(/\/$/, "");
  try {
    const grant = JSON.parse(
      await executeTool(
        "session_sync",
        { projects: ["Project A"] },
        {
          publicApiBaseUrl: "https://orc.example.com",
        },
      ),
    );
    expect(grant.sync_url).toBe(`https://orc.example.com/api/session-sync/${token}`);
    expect(grant.projects[0].name).toBe("Project A");
    const stdio = JSON.parse(await executeTool("session_sync", {}));
    expect(new URL(stdio.sync_url).origin).toBe(server.url.origin);
  } finally {
    if (previous === undefined) delete process.env.ORC_API_BASE;
    else process.env.ORC_API_BASE = previous;
    await server.stop(true);
  }
});
