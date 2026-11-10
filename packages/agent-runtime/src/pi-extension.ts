import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function piExtension(pi: ExtensionAPI): void {
  const config = JSON.parse(process.env.ORC_PI_SESSION_CONFIG ?? "{}");
  delete process.env.ORC_PI_SESSION_CONFIG;
  if (config.server)
    pi.registerMcpServer(config.serverName, { ...config.server, exposure: "direct" });
  pi.registerCommand("orc-adapter-check", {
    description: "Check the ORC session bridge",
    handler: async (_args, ctx) => {
      const deadline = Date.now() + 10_000;
      let connected = !config.server;
      while (!connected && Date.now() < deadline) {
        connected = pi
          .getAllTools()
          .some((tool) => tool.name.startsWith(`mcp__${config.serverName}__`));
        if (!connected) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      ctx.ui.notify(
        connected ? "orc-adapter-ready" : "orc-adapter-mcp-failed",
        connected ? "info" : "error",
      );
    },
  });
  pi.on("tool_call", async (event, ctx) => {
    const approved = await ctx.ui.confirm(
      "ORC tool approval",
      JSON.stringify({ tool: event.toolName, input: event.input }),
    );
    if (!approved) return { block: true, reason: "Denied by ORC permissions." };
    return undefined;
  });
}
