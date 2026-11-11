import { homedir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "drizzle-kit";

const orcHome = process.env.ORC_HOME?.trim() || join(homedir(), ".orc");
const dbPath = process.env.ORC_DB_PATH ?? join(orcHome, "orc.db");

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: dbPath,
  },
  verbose: true,
  strict: true,
});
