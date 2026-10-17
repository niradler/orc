// Writes the API's OpenAPI document from this checkout, without a running daemon.
// Usage: bun scripts/dump-openapi.ts <out.json>
import { writeFileSync } from "node:fs";
import { resetConfig } from "@orc/core/config";
import { closeDb, createTestDb } from "@orc/db/client";
import { createApp } from "../src/server.js";

const out = process.argv[2];
if (!out) throw new Error("Usage: bun scripts/dump-openapi.ts <out.json>");

process.env.ORC_API_SECRET = "dump-openapi";
process.env.ORC_DB_PATH = ":memory:";
resetConfig();
createTestDb();
try {
  const res = await createApp().request("/openapi.json", {
    headers: { Authorization: "Bearer dump-openapi" },
  });
  if (!res.ok) throw new Error(`openapi.json answered ${res.status}`);
  writeFileSync(out, `${JSON.stringify(await res.json(), null, 2)}\n`);
} finally {
  closeDb();
}
