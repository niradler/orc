import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export function piExtension(
  pi: ExtensionAPI,
  config: {
    serverName: string;
    server?: { type: "http"; url: string; headers?: Record<string, string> };
  },
): void {
  if (config.server)
    pi.registerMcpServer(config.serverName, { ...config.server, exposure: "direct" });
  const connected = async () => {
    const deadline = Date.now() + 10_000;
    while (config.server && Date.now() < deadline) {
      if (pi.getAllTools().some((tool) => tool.name.startsWith(`mcp__${config.serverName}__`)))
        return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return !config.server;
  };
  pi.registerCommand("orc-adapter-check", {
    description: "Check the ORC session bridge",
    handler: async (_args, ctx) => {
      const ready = await connected();
      ctx.ui.notify(
        ready ? "orc-adapter-ready" : "orc-adapter-mcp-failed",
        ready ? "info" : "error",
      );
    },
  });
  pi.on("session_start", (event, ctx) => {
    if (event.reason === "reload") ctx.ui.notify("orc-adapter-reloaded", "info");
  });
  const blockReplacement = (_event: unknown, ctx: ExtensionContext) => {
    ctx.ui.notify("orc-adapter-session-replacement-blocked", "error");
    return { cancel: true };
  };
  pi.on("session_before_switch", blockReplacement);
  pi.on("session_before_fork", blockReplacement);
  pi.on("session_before_tree", blockReplacement);
  pi.on("tool_call", async (event, ctx) => {
    const approved = await ctx.ui.confirm(
      "ORC tool approval",
      JSON.stringify({ tool: event.toolName, input: event.input }),
    );
    if (!approved) return { block: true, reason: "Denied by ORC permissions." };
    return undefined;
  });
}
