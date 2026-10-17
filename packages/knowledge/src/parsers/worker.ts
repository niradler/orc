/**
 * Parser subprocess entry. One process per job keeps parser memory, crashes and hangs out of the
 * API server. Runs as `bun worker.ts <request>` from source, or as the hidden CLI command
 * `orc __orc-kb-parse <request>` in compiled/bundled builds.
 *
 * Result goes to request.output (not stdout: PDF/Office libraries log to the console).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { assertZipWithinLimits, parseBasic } from "./basic.js";

export const PARSER_WORKER_COMMAND = "__orc-kb-parse";

/** "zip-check" only vets an Office archive's expansion (before handing it to Docling). */
export type ParserWorkerRequest = {
  parser: "basic" | "zip-check";
  input: string;
  ext: string;
  output: string;
};

export async function runParserWorker(raw: string | undefined): Promise<number> {
  let req: ParserWorkerRequest;
  try {
    req = JSON.parse(raw ?? "") as ParserWorkerRequest;
  } catch {
    process.stderr.write("invalid parser request\n");
    return 2;
  }
  if (req.parser === "zip-check") {
    try {
      await assertZipWithinLimits(readFileSync(req.input));
      return 0;
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      return 1;
    }
  }
  if (req.parser !== "basic") {
    process.stderr.write(`unknown parser ${String(req.parser)}\n`);
    return 2;
  }
  const result = await parseBasic(req.input, req.ext);
  writeFileSync(req.output, JSON.stringify(result));
  return 0;
}

if (import.meta.main) process.exit(await runParserWorker(process.argv[2]));
