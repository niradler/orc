import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const destination = join(import.meta.dir, "dist", "skills");
mkdirSync(destination, { recursive: true });
cpSync(join(import.meta.dir, "../../skills"), destination, { recursive: true });
console.log(`Copied built-in skills to ${destination}`);
