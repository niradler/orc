import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { executeTool } from "@orc/mcp/tools";
import type { createApp } from "../server.js";
import { req, setupTestApp, teardownTestApp } from "./helpers.js";

let app: ReturnType<typeof createApp>;
let projectId: string;
const originalAgent = process.env.ORC_AGENT;

beforeAll(async () => {
  app = setupTestApp();
  process.env.ORC_AGENT = "claude";
  projectId = (await (await req(app, "POST", "/projects", { name: "pad-mcp" })).json()).id;
  await req(app, "POST", "/projects", { name: "pad-other" });
});

afterAll(() => {
  if (originalAgent === undefined) delete process.env.ORC_AGENT;
  else process.env.ORC_AGENT = originalAgent;
  teardownTestApp();
});

const options = { agentSessionId: "native-mcp", publicApiBaseUrl: "http://orc.test" };
const idOf = (result: string) => /scratchpad (\w+)/.exec(result)?.[1] as string;

async function tool(name: string, args: Record<string, unknown>) {
  const res = await req(app, "POST", "/mcp/tool", { name, args });
  const body = await res.json();
  return { status: res.status, result: body.result as string, error: body.error as string };
}

describe("scratchpad MCP tools", () => {
  test("should create a pad linked to the agent session and return a deep link", async () => {
    const created = await executeTool(
      "pad_create",
      { kind: "doc", title: "Design notes", content: "# Notes", project: "pad-mcp" },
      options,
    );
    const id = idOf(created);
    expect(created).toContain(`http://orc.test/scratchpad/${id}`);

    const read = await executeTool("pad_get", { id }, options);
    expect(read).toContain("# Design notes");
    expect(read).toContain("revision: 1 | author: claude");
    expect(read).toContain("project: pad-mcp | session: native-mcp");
    expect(read.endsWith("---\n# Notes")).toBe(true);

    const unlinked = idOf(
      await executeTool(
        "pad_create",
        { kind: "diagram", title: "Loose", link_session: false },
        options,
      ),
    );
    expect(await executeTool("pad_list", { session: "current" }, options)).not.toContain(unlinked);
    expect(await executeTool("pad_list", { session: "current" }, options)).toContain(id);
    expect(await executeTool("pad_list", { unassigned: true }, options)).toContain(unlinked);
  });

  test("should update with if_revision, unlink a project and delete", async () => {
    const id = idOf(
      await executeTool("pad_create", { kind: "html", title: "Page", project: "pad-mcp" }, options),
    );
    expect(
      await executeTool("pad_update", { id, content: "<p>v2</p>", if_revision: 1 }, options),
    ).toContain("revision 2");
    await expect(
      executeTool("pad_update", { id, content: "<p>stale</p>", if_revision: 1 }, options),
    ).rejects.toThrow("expected 1");
    await executeTool("pad_update", { id, project: null }, options);
    expect((await (await req(app, "GET", `/scratchpads/${id}`)).json()).project_id).toBeNull();

    expect(await executeTool("pad_delete", { id }, options)).toBe(`Deleted scratchpad ${id}`);
    await expect(executeTool("pad_get", { id }, options)).rejects.toThrow("not found");
  });

  test("should hide other projects' pads from a project-scoped connection", async () => {
    const mine = idOf(
      await executeTool("pad_create", { kind: "doc", title: "Mine", project: "pad-mcp" }, options),
    );
    const theirs = idOf(
      await executeTool(
        "pad_create",
        { kind: "doc", title: "Theirs", project: "pad-other" },
        options,
      ),
    );
    const inScope = { ...options, projectScopes: [{ id: projectId, name: "pad-mcp" }] };
    const scoped = await executeTool("pad_list", {}, inScope);
    expect(scoped).toContain(mine);
    expect(scoped).not.toContain(theirs);

    // Reaching another project's pad by id behaves as if it did not exist.
    for (const [name, args] of [
      ["pad_get", { id: theirs }],
      ["pad_get", { id: theirs, via: "url" }],
      ["pad_update", { id: theirs, content: "# Mine now" }],
      ["pad_update", { id: theirs, via: "url" }],
      ["pad_delete", { id: theirs }],
    ] as const)
      await expect(executeTool(name, args, inScope)).rejects.toThrow("not found");
    await expect(
      executeTool("pad_create", { kind: "doc", title: "Escape", project: "pad-other" }, inScope),
    ).rejects.toThrow("outside the selected MCP projects");
    await expect(
      executeTool("pad_update", { id: mine, project: "pad-other" }, inScope),
    ).rejects.toThrow("outside the selected MCP projects");
    expect(await executeTool("pad_get", { id: theirs }, options)).toContain("revision: 1");
  });

  test("should move large content through signed URLs minted by the API", async () => {
    const created = await tool("pad_create", { kind: "doc", title: "Big" });
    const id = idOf(created.result);

    const refused = await tool("pad_update", { id, via: "url", content: "x" });
    expect(refused.status).toBe(400);
    for (const field of [{ title: "Renamed" }, { tags: ["x"] }, { project: null }])
      expect((await tool("pad_update", { id, via: "url", ...field })).status).toBe(400);
    expect((await tool("pad_update", { id, project: "" })).status).toBe(400);

    const upload = JSON.parse(
      (await tool("pad_update", { id, via: "url", if_revision: 1 })).result,
    );
    const big = `# Big\n\n${"line\n".repeat(50_000)}`;
    const put = await app.request(upload.upload_url, { method: "PUT", body: big });
    expect(put.status).toBe(200);

    const download = JSON.parse((await tool("pad_get", { id, via: "url" })).result);
    expect(download.revision).toBe(2);
    expect(await (await app.request(download.download_url)).text()).toBe(big);

    const stale = await tool("pad_update", { id, via: "url", if_revision: 1 });
    expect(stale.status).toBe(409);
  });
});
