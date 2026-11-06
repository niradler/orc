import { createApp } from "@orc/api/server";
import { resetConfig } from "@orc/core/config";

resetConfig();
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createApp().fetch });
console.log(server.port);
await new Promise(() => {});
