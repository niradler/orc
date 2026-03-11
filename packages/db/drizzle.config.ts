import { defineConfig } from "drizzle-kit";
import { homedir } from "os";
import { join } from "path";

const dbPath = process.env["ORC_DB_PATH"] ?? join(homedir(), ".orc", "orc.db");

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
