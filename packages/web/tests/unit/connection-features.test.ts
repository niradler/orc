import { expect, test } from "bun:test";
import { isMcpConnection, templateVariables } from "../../src/lib/connection-features";

test("reads every variable of a URI template once, without operators or modifiers", () => {
  expect(templateVariables("docs://pages/{slug}")).toEqual(["slug"]);
  expect(templateVariables("file:///{+path}{?q,lang}")).toEqual(["path", "q", "lang"]);
  expect(templateVariables("x://{list*}/{name:3}/{name}")).toEqual(["list", "name"]);
  expect(templateVariables("docs://readme")).toEqual([]);
});

test("only MCP transports have resources and prompts", () => {
  expect(["http", "sse", "stdio"].every(isMcpConnection)).toBe(true);
  expect(["openapi", "graphql", null].some(isMcpConnection)).toBe(false);
});
