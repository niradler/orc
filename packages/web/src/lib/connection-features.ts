// spec-cli addresses MCP resources and prompts in the tool namespace, so the tool filter covers them.
export const resourceFilterId = (uri: string) => `resource:${uri}`;
export const promptFilterId = (name: string) => `prompt:${name}`;

/** Connection types served by an MCP server, the only kind with resources and prompts. */
export const isMcpConnection = (type: string | null) =>
  type === "http" || type === "sse" || type === "stdio";

/**
 * The variable names of an RFC 6570 URI template, in order: `docs://{+path}{?q,lang}` gives
 * path, q and lang.
 */
export function templateVariables(template: string) {
  const names = [...template.matchAll(/\{([^}]+)\}/g)].flatMap((match) =>
    (match[1] ?? "")
      .replace(/^[+#./;?&]/, "")
      .split(",")
      .map((name) => name.replace(/\*$|:\d+$/, "").trim()),
  );
  return [...new Set(names.filter(Boolean))];
}
