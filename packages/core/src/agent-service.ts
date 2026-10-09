import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { parseMarkdownFrontmatter } from "./markdown-frontmatter.js";
import { getPackagesDir } from "./package-paths.js";
import type { AgentFields, AgentFull, AgentProfile, BrokenAgent } from "./primitive-types.js";

import { readSkillFile, validateSkillPath } from "./skill-files.js";

export type { AgentFields, AgentFull, AgentProfile, BrokenAgent } from "./primitive-types.js";

export const AgentFieldsSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().trim().min(1),
    model: z.string().min(1).optional(),
    tools: z.union([z.record(z.string(), z.boolean()), z.array(z.string()), z.string()]).optional(),
    color: z.string().optional(),
    handoffs: z
      .array(
        z.union([
          z.string(),
          z
            .object({
              agent: z.string(),
              label: z.string().optional(),
              prompt: z.string().optional(),
              send: z.boolean().optional(),
            })
            .passthrough(),
        ]),
      )
      .optional(),
  })
  .passthrough();

export function getUserAgentsDir(): string {
  return join(homedir(), ".orc", "agents");
}

export function parseAgent(
  content: string,
  filename: string,
): { fields: AgentFields; body: string } {
  if (!filename.endsWith(".agent.md"))
    throw new ValidationError("Agent files must end in .agent.md");
  const parsed = parseMarkdownFrontmatter(content);
  const fields = AgentFieldsSchema.safeParse(parsed.fields);
  if (!fields.success)
    throw new ValidationError(`Invalid agent frontmatter: ${fields.error.message}`);
  return {
    fields: { ...fields.data, name: fields.data.name ?? basename(filename, ".agent.md") },
    body: parsed.body,
  };
}

export function discoverAgents(cwd = process.cwd()): {
  agents: AgentProfile[];
  broken: BrokenAgent[];
} {
  const agents = new Map<string, AgentProfile>();
  const broken: BrokenAgent[] = [];
  function scan(
    directory: string,
    source: AgentProfile["source"],
    prefix = "",
    recursive = true,
  ): void {
    if (!existsSync(directory) || lstatSync(directory).isSymbolicLink()) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (recursive) scan(path, source, `${prefix}${entry.name}/`);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".agent.md")) continue;
      try {
        const raw = readSkillFile(directory, entry.name, false).content;
        const { fields } = parseAgent(raw, entry.name);
        const id = `${prefix}${basename(entry.name, ".agent.md")}`;
        agents.set(id, {
          id,
          name: fields.name as string,
          description: fields.description,
          source,
          path,
          fields,
        });
      } catch (error) {
        broken.push({ path, error: (error as Error).message });
      }
    }
  }
  const packages = getPackagesDir();
  if (existsSync(packages)) {
    for (const entry of readdirSync(packages, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (
          existsSync(join(packages, entry.name, "plugin.json")) &&
          !existsSync(join(packages, entry.name, "apm.yml"))
        )
          continue;
        const apmDir = join(packages, entry.name, ".apm");
        if (!existsSync(apmDir) || !lstatSync(apmDir).isSymbolicLink())
          scan(join(apmDir, "agents"), "package", `${entry.name}/`);
        scan(join(packages, entry.name), "package", `${entry.name}/`, false);
      }
    }
  }
  scan(getUserAgentsDir(), "user");
  const projectApm = join(cwd, ".apm");
  if (!existsSync(projectApm) || !lstatSync(projectApm).isSymbolicLink())
    scan(join(projectApm, "agents"), "project");
  return { agents: [...agents.values()].sort((a, b) => a.id.localeCompare(b.id)), broken };
}

export function readAgent(id: string, cwd = process.cwd()): AgentFull | null {
  const agent = discoverAgents(cwd).agents.find((entry) => entry.id === id);
  if (!agent) return null;
  const raw = readSkillFile(dirname(agent.path), basename(agent.path), false).content;
  const { fields, body } = parseAgent(raw, agent.path);
  return { ...agent, fields, content: body, raw };
}

export function createAgent(id: string, content: string): AgentFull {
  validateSkillPath(id);
  if (id.includes("/") || id.length > 200)
    throw new ValidationError("Agent ID must be a filename stem");
  const filename = `${id}.agent.md`;
  const { fields, body } = parseAgent(content, filename);
  const directory = getUserAgentsDir();
  mkdirSync(directory, { recursive: true });
  const path = join(directory, filename);
  if (existsSync(path)) throw new ConflictError(`Agent already exists: ${id}`);
  writeFileSync(path, content, { encoding: "utf8", flag: "wx" });
  return {
    id,
    name: fields.name as string,
    description: fields.description,
    source: "user",
    path,
    fields,
    content: body,
    raw: content,
  };
}

export function renderAgentInstructions(agent: AgentFull): string {
  return `## Agent profile: ${agent.name}\n${agent.content}\n\nAgent definition: ${agent.path}\nResolve references relative to this file's directory.\n${agent.fields.handoffs ? `Declared handoffs: ${JSON.stringify(agent.fields.handoffs)}\nORC flow edges determine which handoff runs; declarations do not start agents automatically.` : ""}`;
}

function agentFilePath(id: string, cwd: string): string {
  validateSkillPath(id);
  const agent = discoverAgents(cwd).agents.find((entry) => entry.id === id);
  if (!agent) throw new NotFoundError("Agent", id);
  let directory = getUserAgentsDir();
  if (agent.source === "package") directory = getPackagesDir();
  if (agent.source === "project") directory = join(cwd, ".apm", "agents");
  const root = resolve(directory);
  const inside = relative(root, agent.path);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    throw new ValidationError("Agent file must stay inside its source directory");
  if (lstatSync(root).isSymbolicLink() || relative(root, realpathSync(root)) !== "")
    throw new ValidationError("Agent directory symlinks are not allowed");
  let path = root;
  for (const part of inside.split(sep)) {
    path = join(path, part);
    if (lstatSync(path).isSymbolicLink())
      throw new ValidationError("Agent file symlinks are not allowed");
  }
  if (!lstatSync(path).isFile()) throw new NotFoundError("Agent", id);
  return path;
}

export function deleteAgent(id: string, cwd = process.cwd()): void {
  unlinkSync(agentFilePath(id, cwd));
}

export function updateAgent(
  id: string,
  input: { content: string; expectedRaw: string; expectedPath: string },
  cwd = process.cwd(),
): AgentFull {
  const path = agentFilePath(id, cwd);
  const current = readAgent(id, cwd);
  if (!current) throw new NotFoundError("Agent", id);
  if (current.raw !== input.expectedRaw || current.path !== input.expectedPath)
    throw new ConflictError("This agent changed since you opened it. Reopen it before saving.");
  parseAgent(input.content, path);
  writeFileSync(path, input.content, { encoding: "utf8" });
  const updated = readAgent(id, cwd);
  if (!updated) throw new NotFoundError("Agent", id);
  return updated;
}
