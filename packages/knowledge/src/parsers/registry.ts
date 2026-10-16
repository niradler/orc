import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { OrcConfig } from "@orc/core/config";
import { type KbParserInfo, type ParsedDocument, ParsedDocumentSchema } from "@orc/core/kb";
import { markdownToBlocks } from "../markdown.js";
import { BASIC_FORMATS, BASIC_PARSER_ID, BASIC_PARSER_VERSION } from "./basic.js";
import {
  DOCLING_FORMATS,
  DOCLING_PARSER_ID,
  doclingApproxBytes,
  doclingCommand,
  readDoclingManifest,
} from "./docling.js";
import { PARSER_WORKER_COMMAND, type ParserWorkerRequest } from "./worker.js";

type KnowledgeConfig = OrcConfig["knowledge"];

export const PARSER_IDS = [BASIC_PARSER_ID, DOCLING_PARSER_ID] as const;
export type ParserId = (typeof PARSER_IDS)[number];

export class ParserUnavailableError extends Error {}

export function listParsers(root: string, cfg: KnowledgeConfig): KbParserInfo[] {
  const docling = readDoclingManifest(root);
  return [
    {
      id: BASIC_PARSER_ID,
      label: "Built-in",
      version: BASIC_PARSER_VERSION,
      installed: true,
      enabled: true,
      capabilities: {
        formats: BASIC_FORMATS,
        ocr: false,
        tables: true,
        page_locators: true,
        bbox_locators: false,
      },
      size_bytes: null,
      description:
        "Markdown, text, HTML, DOCX, PPTX, XLSX, CSV and text-layer PDFs. Office tables, DOCX headings, PDF page and slide locators.",
    },
    {
      id: DOCLING_PARSER_ID,
      label: "Docling",
      version: docling?.docling ?? "",
      installed: !!docling,
      enabled: !!docling && cfg.docling_enabled,
      capabilities: {
        formats: DOCLING_FORMATS,
        ocr: true,
        tables: true,
        page_locators: true,
        bbox_locators: true,
      },
      size_bytes: docling?.size_bytes ?? doclingApproxBytes(),
      description:
        "Optional download. Adds OCR for scans and images, PDF headings and table structure, and bounding-box locators. Used automatically for PDF and images once installed.",
    },
  ];
}

/**
 * Parser for a file: an explicit KB/workspace choice wins; "auto" uses Docling where it adds
 * capability (PDF, images) when installed and enabled, the built-in parser otherwise.
 */
export function selectParser(
  ext: string,
  kbParser: string | null,
  root: string,
  cfg: KnowledgeConfig,
): ParserId {
  const choice = kbParser ?? cfg.parser;
  const doclingReady = !!readDoclingManifest(root) && cfg.docling_enabled;
  if (choice === DOCLING_PARSER_ID && DOCLING_FORMATS.includes(ext)) {
    if (!doclingReady)
      throw new ParserUnavailableError(
        "This knowledge base uses Docling, which is not installed or is disabled. Install it in Settings or switch the parser.",
      );
    return DOCLING_PARSER_ID;
  }
  if (choice === "auto" && doclingReady && DOCLING_FORMATS.includes(ext)) return DOCLING_PARSER_ID;
  if (BASIC_FORMATS.includes(ext)) return BASIC_PARSER_ID;
  if (DOCLING_FORMATS.includes(ext))
    throw new ParserUnavailableError(
      `.${ext} files need OCR. Install the Docling parser in Settings to extract their text.`,
    );
  throw new ParserUnavailableError(`.${ext} files are not supported`);
}

const compiled = import.meta.path.includes("$bunfs") || import.meta.path.includes("~BUN");
const sourceWorker = join(import.meta.dir, "worker.ts");

/** How to start the built-in parser in a child process for this build flavour. */
export function basicWorkerCommand(request: string): string[] {
  const override = process.env.ORC_KB_PARSER_WORKER;
  if (override) return [process.execPath, override, request];
  if (!compiled && existsSync(sourceWorker)) return [process.execPath, sourceWorker, request];
  // Compiled binary dispatches the hidden command itself; a bundled script needs its entry path.
  if (compiled) return [process.execPath, PARSER_WORKER_COMMAND, request];
  return [process.execPath, Bun.main, PARSER_WORKER_COMMAND, request];
}

export type RunParserOptions = { root: string; workDir: string; timeoutSecs: number };

/** Parser output is read back into the server process; anything larger is refused. */
const MAX_PARSER_OUTPUT_BYTES = 256 * 2 ** 20;
const SECRET_ENV = /SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL/i;

/** Parsers run untrusted files through third-party code: they get no secrets from our env. */
function parserEnv(extra: Record<string, string>) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !SECRET_ENV.test(k)) env[k] = v;
  return { ...env, ...extra };
}

async function runChild(cmd: string[], env: Record<string, string>, timeoutSecs: number) {
  const proc = Bun.spawn(cmd, {
    env: parserEnv(env),
    stdout: "ignore",
    stderr: "pipe",
    windowsHide: true,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutSecs * 1000);
  const stderr = new Response(proc.stderr).text();
  const code = await proc.exited;
  clearTimeout(timer);
  if (timedOut) throw new Error(`Parser timed out after ${timeoutSecs}s`);
  const tail = (await stderr).trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 400);
  return { code, tail };
}

const OFFICE_EXTS = ["docx", "pptx", "xlsx"];

export async function runParser(
  parser: ParserId,
  input: string,
  ext: string,
  expectedSha256: string,
  opts: RunParserOptions,
): Promise<ParsedDocument> {
  mkdirSync(opts.workDir, { recursive: true });
  const output = join(opts.workDir, `${parser}-${randomUUID()}.json`);
  let cmd: string[];
  let env: Record<string, string> = {};
  if (parser === BASIC_PARSER_ID) {
    const req: ParserWorkerRequest = { parser: "basic", input, ext, output };
    cmd = basicWorkerCommand(JSON.stringify(req));
  } else {
    if (OFFICE_EXTS.includes(ext)) {
      // The built-in parser vets archive expansion itself; Docling gets the same check first.
      const req: ParserWorkerRequest = { parser: "zip-check", input, ext, output };
      const check = await runChild(basicWorkerCommand(JSON.stringify(req)), {}, opts.timeoutSecs);
      if (check.code !== 0) throw new Error(`Refused archive: ${check.tail || "invalid zip"}`);
    }
    ({ cmd, env } = doclingCommand(opts.root, input, output));
  }
  try {
    const { code, tail } = await runChild(cmd, env, opts.timeoutSecs);
    if (code !== 0 || !existsSync(output))
      throw new Error(`Parser exited with code ${code}${tail ? `: ${tail}` : ""}`);
    if (statSync(output).size > MAX_PARSER_OUTPUT_BYTES)
      throw new Error(
        `Parser output exceeds ${MAX_PARSER_OUTPUT_BYTES / 2 ** 20} MB; split the document`,
      );
    const parsed = ParsedDocumentSchema.safeParse(JSON.parse(readFileSync(output, "utf8")));
    if (!parsed.success)
      throw new Error(`Parser returned an invalid result: ${parsed.error.message.slice(0, 300)}`);
    const doc = parsed.data;
    if (doc.source_sha256 !== expectedSha256)
      throw new Error("Parser read different bytes than were stored");
    // Docling emits structured blocks; fall back to normalizing its Markdown if it gave none.
    if (!doc.blocks.length && doc.markdown && doc.status !== "failed")
      doc.blocks = markdownToBlocks(doc.markdown);
    return doc;
  } finally {
    rmSync(output, { force: true });
  }
}
