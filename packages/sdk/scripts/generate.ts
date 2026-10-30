import { resolve } from "node:path";
import openapiTS, { astToString, COMMENT_HEADER } from "openapi-typescript";

const directory = resolve(import.meta.dir, "..");
const source = Bun.spawnSync(["bun", "../api/scripts/dump-openapi.ts", "-"], {
  cwd: directory,
  stdout: "pipe",
  stderr: "inherit",
  timeout: 30000,
});
if (source.exitCode !== 0) throw new Error(`Source OpenAPI generation failed (${source.exitCode})`);
const document = JSON.parse(source.stdout.toString());
const types = await openapiTS(document);
await Bun.write(resolve(directory, "src/openapi.gen.ts"), COMMENT_HEADER + astToString(types));
