export * from "./server.js";
export * from "./tools.js";

if (import.meta.main) {
  const { startStdioServer } = await import("./server.js");
  await startStdioServer();
}
