import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FLOW_NAME_RE, type FlowDefinition, parseFlowDefinition } from "./flow.js";
import { BUILTIN_FLOW_SOURCES } from "./flows/builtin.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FlowSource = "builtin" | "user" | "project";

export type FlowMeta = {
  name: string;
  description: string;
  source: FlowSource;
  path: string | null;
  version: number;
  entry: string;
  node_count: number;
  edge_count: number;
};

export type FlowFull = FlowMeta & { definition: FlowDefinition };

export type ListFlowsOpts = {
  q?: string | undefined;
  source?: FlowSource | undefined;
  reload?: boolean | undefined;
};

export type BrokenFlow = { name: string; path: string; errors: string[] };

// ---------------------------------------------------------------------------
// Directories
//
// Precedence mirrors config loading: builtin, then ~/.orc, then the project's
// ./.orc — a later source with the same name shadows the earlier one, so a repo
// can pin its own `orc-default` without touching the global install.
// ---------------------------------------------------------------------------

function userFlowsDir(): string {
  return join(homedir(), ".orc", "flows");
}

function projectFlowsDir(): string {
  return join(process.cwd(), ".orc", "flows");
}

export function getUserFlowsDir(): string {
  return userFlowsDir();
}

export function getProjectFlowsDir(): string {
  return projectFlowsDir();
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

type ScanResult = { flows: Map<string, FlowFull>; broken: BrokenFlow[] };

function flowFilePath(dir: string, name: string): string {
  return join(dir, name, "flow.json");
}

function scanDirectory(dir: string, source: FlowSource, into: ScanResult): void {
  if (!existsSync(dir)) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const file = flowFilePath(dir, entry);
    try {
      if (!statSync(join(dir, entry)).isDirectory()) continue;
      if (!existsSync(file)) continue;
      const raw: unknown = JSON.parse(readFileSync(file, "utf-8"));
      const parsed = parseFlowDefinition(raw);
      if (!parsed.ok) {
        into.broken.push({ name: entry, path: file, errors: parsed.errors });
        continue;
      }
      if (parsed.definition.name !== entry) {
        into.broken.push({
          name: entry,
          path: file,
          errors: [
            `directory is "${entry}" but the definition is named "${parsed.definition.name}"`,
          ],
        });
        continue;
      }
      into.flows.set(parsed.definition.name, toFull(parsed.definition, source, file));
    } catch (err) {
      into.broken.push({
        name: entry,
        path: file,
        errors: [err instanceof Error ? err.message : String(err)],
      });
    }
  }
}

function toFull(definition: FlowDefinition, source: FlowSource, path: string | null): FlowFull {
  return {
    name: definition.name,
    description: definition.description,
    source,
    path,
    version: definition.version,
    entry: definition.entry,
    node_count: Object.keys(definition.nodes).length,
    edge_count: definition.edges.length,
    definition,
  };
}

function scanAll(): ScanResult {
  const result: ScanResult = { flows: new Map(), broken: [] };

  for (const [name, raw] of Object.entries(BUILTIN_FLOW_SOURCES)) {
    const parsed = parseFlowDefinition(raw);
    if (!parsed.ok) {
      // A broken builtin is a bug in orc, not user error — surface it loudly
      // rather than silently shipping a flow nothing can run.
      result.broken.push({ name, path: "(builtin)", errors: parsed.errors });
      continue;
    }
    result.flows.set(name, toFull(parsed.definition, "builtin", null));
  }

  scanDirectory(userFlowsDir(), "user", result);
  scanDirectory(projectFlowsDir(), "project", result);
  return result;
}

// In-memory only, unlike the skills cache: flow definitions are small and are
// read on every flow start, and a stale on-disk cache silently running the
// wrong graph is a much worse failure than an extra directory scan.
let _cache: ScanResult | null = null;

function ensureCache(): ScanResult {
  if (!_cache) _cache = scanAll();
  return _cache;
}

export function reloadFlows(): void {
  _cache = null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function listFlows(opts?: ListFlowsOpts): FlowMeta[] {
  if (opts?.reload) reloadFlows();
  const cache = ensureCache();
  let flows = [...cache.flows.values()].map(({ definition: _definition, ...meta }) => meta);

  if (opts?.source) flows = flows.filter((f) => f.source === opts.source);
  if (opts?.q) {
    const q = opts.q.toLowerCase();
    flows = flows.filter(
      (f) => f.name.toLowerCase().includes(q) || f.description.toLowerCase().includes(q),
    );
  }
  return flows.sort((a, b) => a.name.localeCompare(b.name));
}

export function listBrokenFlows(): BrokenFlow[] {
  return [...ensureCache().broken];
}

export function readFlow(name: string): FlowFull | null {
  return ensureCache().flows.get(name) ?? null;
}

export function flowExists(name: string): boolean {
  return ensureCache().flows.has(name);
}

export function createFlow(raw: unknown, opts?: { overwrite?: boolean }): FlowFull {
  const parsed = parseFlowDefinition(raw);
  if (!parsed.ok) {
    throw new Error(`Invalid flow definition:\n  ${parsed.errors.join("\n  ")}`);
  }
  const definition = parsed.definition;
  if (!FLOW_NAME_RE.test(definition.name)) {
    throw new Error(`Invalid flow name: ${definition.name}`);
  }

  const dir = join(userFlowsDir(), definition.name);
  const file = flowFilePath(userFlowsDir(), definition.name);
  if (existsSync(file) && !opts?.overwrite) {
    throw new Error(`Flow already exists: ${definition.name}`);
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(definition, null, 2)}\n`, "utf-8");
  reloadFlows();

  return toFull(definition, "user", file);
}

/**
 * Resolve what a task should actually run: an inline per-task graph wins over a
 * named flow, which wins over the configured default.
 */
export function resolveFlowForTask(opts: {
  flowOverride?: unknown;
  flowName?: string | null | undefined;
  defaultFlowName: string;
}): { definition: FlowDefinition; source: FlowSource | "task"; name: string } | { error: string } {
  if (opts.flowOverride !== undefined && opts.flowOverride !== null) {
    const parsed = parseFlowDefinition(opts.flowOverride);
    if (!parsed.ok) {
      return { error: `Invalid inline flow: ${parsed.errors.join("; ")}` };
    }
    return { definition: parsed.definition, source: "task", name: parsed.definition.name };
  }

  const name = opts.flowName || opts.defaultFlowName;
  const flow = readFlow(name);
  if (!flow) return { error: `Flow not found: ${name}` };
  return { definition: flow.definition, source: flow.source, name: flow.name };
}
