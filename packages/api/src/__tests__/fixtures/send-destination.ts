// A second ORC installation for send-to tests: the real routes and database,
// without the watcher, terminals or channel runtime. The parent test owns the
// environment (isolated ORC_HOME, DB, agent home, secret) and the lifecycle.
import { loadConfig } from "@orc/core/config";
import { createApp } from "../../server.js";

const config = loadConfig();
const app = createApp();
const server = Bun.serve({
  port: config.api.port,
  hostname: "127.0.0.1",
  fetch: (request) => app.fetch(request),
});
console.log(`PORT=${server.port}`);
