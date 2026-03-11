import { Database } from "bun:sqlite";
import { loadConfig } from "@orc/core/config";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { mkdirSync } from "fs";
import { dirname, join } from "path";

const config = loadConfig();
const dbPath = config.db.path;

mkdirSync(dirname(dbPath), { recursive: true });

const sqlite = new Database(dbPath);
sqlite.exec("PRAGMA journal_mode=WAL;");
sqlite.exec("PRAGMA foreign_keys=ON;");

const db = drizzle(sqlite);
const migrationsFolder = join(import.meta.dirname, "..", "drizzle");

migrate(db, { migrationsFolder });
console.log("Migrations complete:", dbPath);
sqlite.close();
