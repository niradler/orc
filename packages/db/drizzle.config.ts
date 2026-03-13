import { homedir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "drizzle-kit";

const dbPath = process.env.ORC_DB_PATH ?? join(homedir(), ".orc", "orc.db");

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
