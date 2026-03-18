import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let version: string;
try {
  const __dir = dirname(fileURLToPath(import.meta.url));
  version = JSON.parse(readFileSync(join(__dir, "..", "package.json"), "utf-8")).version;
} catch {
  version = process.env.ORC_VERSION ?? "0.0.0";
}

export const ORC_VERSION = version;
