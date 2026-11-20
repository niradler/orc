import { describe, expect, test } from "bun:test";
import { scriptToolInfo } from "../code-mode.js";
import { runMetaTool, type ToolResult } from "../meta-tools.js";
import {
  discoverSpecTools,
  externalHitLine,
  markExternal,
  specSignpost,
} from "../spec-discovery.js";
import { specToolDefinitions } from "../spec-tools.js";
import { toolDefinitions } from "../tools.js";

function fakeCallTool(
  opts: {
    connections?: { name: string; description?: string }[];
    toolsByConnection?: Record<string, { id: string; description: string }[]>;
    failConnection?: string;
  } = {},
) {
  return async (name: string, args: unknown): Promise<ToolResult> => {
    const a = args as { connection?: string; tool?: string };
    if (name === "spec_list")
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              opts.connections ?? [{ name: "docs", description: "Docs fixture", enabled: true }],
            ),
          },
        ],
      };
    if (name === "spec_tools") {
      const connection = a.connection as string;
      if (opts.failConnection === connection)
        return { content: [{ type: "text", text: "boom" }], isError: true };
      const tools = opts.toolsByConnection?.[connection] ?? [
        { id: "getPage", description: "Read the release notes page title" },
      ];
      return { content: [{ type: "text", text: JSON.stringify(tools) }] };
    }
    if (name === "spec_describe")
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ name: a.tool, inputSchema: { type: "object" } }),
          },
        ],
      };
    return { content: [{ type: "text", text: "unknown" }], isError: true };
  };
}

const served = [...toolDefinitions, ...specToolDefinitions];
const firstLine = (t: string) => t.split(/\r?\n/)[0] ?? "";

describe("spec discovery helper", () => {
  test("fan-out merges external hits tagged with connection", async () => {
    const d = await discoverSpecTools(fakeCallTool(), ["page"]);
    expect(d.connections.map((c) => c.name)).toEqual(["docs"]);
    const hits = d.hitsByQuery.get("page") ?? [];
    expect(hits[0]).toMatchObject({ name: "getPage", connection: "docs", external: true });
    expect(d.partial).toBe(false);
  });

  test("empty queries return the connection signpost only", async () => {
    const d = await discoverSpecTools(fakeCallTool(), []);
    expect(d.connections.length).toBe(1);
    expect(d.hitsByQuery.size).toBe(0);
  });

  test("a failing connection is skipped and flags partial", async () => {
    const d = await discoverSpecTools(
      fakeCallTool({ connections: [{ name: "docs" }, { name: "bad" }], failConnection: "bad" }),
      ["page"],
    );
    expect(d.partial).toBe(true);
    expect((d.hitsByQuery.get("page") ?? []).some((h) => h.connection === "docs")).toBe(true);
  });

  test("a failing spec_list flags partial and returns no connections", async () => {
    const callTool = async (name: string): Promise<ToolResult> =>
      name === "spec_list"
        ? { content: [{ type: "text", text: "registry down" }], isError: true }
        : { content: [{ type: "text", text: "[]" }] };
    const d = await discoverSpecTools(callTool, ["page"]);
    expect(d.partial).toBe(true);
    expect(d.connections).toEqual([]);
    expect(d.hitsByQuery.size).toBe(0);
  });

  test("a throwing spec_list is caught and flags partial", async () => {
    const callTool = async (name: string): Promise<ToolResult> => {
      if (name === "spec_list") throw new Error("unreachable");
      return { content: [{ type: "text", text: "[]" }] };
    };
    const d = await discoverSpecTools(callTool, ["page"]);
    expect(d.partial).toBe(true);
    expect(d.connections).toEqual([]);
  });

  test("multiple connections merge hits per query", async () => {
    const d = await discoverSpecTools(
      fakeCallTool({
        connections: [{ name: "docs" }, { name: "wiki" }],
        toolsByConnection: {
          docs: [{ id: "getPage", description: "page" }],
          wiki: [{ id: "searchWiki", description: "wiki" }],
        },
      }),
      ["page"],
    );
    const names = (d.hitsByQuery.get("page") ?? []).map((h) => `${h.connection}:${h.name}`);
    expect(names).toContain("docs:getPage");
    expect(names).toContain("wiki:searchWiki");
  });

  test("signpost labels connections as external", () => {
    expect(specSignpost([{ name: "docs", description: "Docs" }])).toContain(
      "External tool connections",
    );
    expect(specSignpost([{ name: "docs", description: "Docs" }])).toContain("not ORC built-ins");
    expect(specSignpost([])).toBe("");
  });

  test("external hit line carries the connection label", () => {
    expect(
      externalHitLine(
        { name: "getPage", description: "Read page", connection: "docs", external: true },
        firstLine,
      ),
    ).toBe("getPage: Read page [external: docs]");
  });

  test("markExternal labels a describe result", () => {
    const r = markExternal(
      { content: [{ type: "text", text: JSON.stringify({ name: "getPage" }) }] },
      "docs",
    );
    expect(r.structuredContent).toMatchObject({
      external: true,
      connection: "docs",
      name: "getPage",
    });
  });

  test("markExternal leaves errors untouched", () => {
    const err: ToolResult = { content: [{ type: "text", text: "nope" }], isError: true };
    expect(markExternal(err, "docs")).toBe(err);
  });
});

describe("tool_search is spec-aware", () => {
  const sc = (res: ToolResult) =>
    (res.structuredContent ?? {}) as {
      connections?: { name: string }[];
      external?: { name: string; connection: string; external: boolean }[];
      results?: { query: string; external: { name: string; connection: string }[] }[];
      partial?: boolean;
    };
  const firstText = (res: ToolResult) => res.content[0]?.text ?? "";

  test("single query surfaces external hits and the signpost", async () => {
    const res = await runMetaTool(
      served,
      "tool_search",
      { query: "release notes page" },
      fakeCallTool(),
      scriptToolInfo,
    );
    const text = firstText(res);
    expect(text).toContain("getPage");
    expect(text).toContain("[external: docs]");
    expect(text).toContain("External tool connections");
    expect(sc(res).external?.[0]).toMatchObject({ connection: "docs", external: true });
    expect(sc(res).connections?.[0]?.name).toBe("docs");
  });

  test("empty query overview lists external connections", async () => {
    const res = await runMetaTool(served, "tool_search", {}, fakeCallTool(), scriptToolInfo);
    expect(firstText(res)).toContain("External tool connections");
    expect(sc(res).connections?.length).toBe(1);
  });

  test("batch queries include external hits per query", async () => {
    const res = await runMetaTool(
      served,
      "tool_search",
      { queries: ["page", "tasks"] },
      fakeCallTool(),
      scriptToolInfo,
    );
    const results = sc(res).results ?? [];
    expect(results[0]?.external[0]).toMatchObject({ name: "getPage", connection: "docs" });
    expect(sc(res).connections?.length).toBe(1);
  });

  test("without spec_invoke served, search stays native-only", async () => {
    const res = await runMetaTool(
      toolDefinitions,
      "tool_search",
      { query: "page" },
      fakeCallTool(),
      scriptToolInfo,
    );
    expect(firstText(res)).not.toContain("[external:");
    expect(sc(res).external ?? []).toEqual([]);
  });

  test("describe with connection labels the tool external", async () => {
    const res = await runMetaTool(
      served,
      "tool_describe",
      { name: "getPage", connection: "docs" },
      fakeCallTool(),
      scriptToolInfo,
    );
    expect(sc(res)).toMatchObject({ external: true, connection: "docs", name: "getPage" });
  });

  test("overview and search survive a failing spec_list", async () => {
    const callTool = async (name: string): Promise<ToolResult> =>
      name === "spec_list"
        ? { content: [{ type: "text", text: "registry down" }], isError: true }
        : { content: [{ type: "text", text: "unknown" }], isError: true };
    const overview = await runMetaTool(served, "tool_search", {}, callTool, scriptToolInfo);
    expect(firstText(overview)).toContain("tools by toolset:");
    expect(firstText(overview)).not.toContain("External tool connections");
    const search = await runMetaTool(
      served,
      "tool_search",
      { query: "task" },
      callTool,
      scriptToolInfo,
    );
    expect(firstText(search)).toContain("task_");
    expect(sc(search).partial).toBe(true);
    expect(sc(search).external ?? []).toEqual([]);
  });
});
