import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, parse, resolve, sep } from "node:path";
import type { OrcProjectRoot } from "./api.js";

export type ProjectChoice = { project: string } | { global: true };

function choiceKey(cwd: string): string {
  return resolve(cwd).toLowerCase();
}

export function readProjectChoices(file: string): Record<string, ProjectChoice> {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => {
        if (!value || typeof value !== "object") return false;
        const choice = value as Record<string, unknown>;
        return typeof choice.project === "string" || choice.global === true;
      }),
    ) as Record<string, ProjectChoice>;
  } catch {
    return {};
  }
}

export function savedProjectChoice(
  file: string,
  cwd: string,
): { choice: ProjectChoice; path: string } | undefined {
  const choices = readProjectChoices(file);
  let current = choiceKey(cwd);
  for (;;) {
    const choice = choices[current];
    if (choice) return { choice, path: current };
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function saveProjectChoice(file: string, cwd: string, choice: ProjectChoice | null): void {
  const choices = readProjectChoices(file);
  const key = choiceKey(cwd);
  if (choice) choices[key] = choice;
  else delete choices[key];
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(choices, null, 2)}\n`, "utf8");
  renameSync(temp, file);
}

export function projectNameFor(cwd: string): string | undefined {
  const name = basename(resolve(cwd))
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return name || undefined;
}

export function shouldAskForProject(cwd: string, home: string): boolean {
  const target = resolve(cwd).toLowerCase();
  if (target === resolve(home).toLowerCase()) return false;
  return target !== parse(target).root.toLowerCase();
}

export type ProjectMatch = {
  projectId: string;
  projectName: string;
  root: string;
};

function isInside(target: string, root: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

/** The deepest ORC project root that contains the session directory. */
export function matchProjectRoot(
  projects: readonly OrcProjectRoot[],
  cwd: string,
): ProjectMatch | undefined {
  const target = resolve(cwd).toLowerCase();
  const candidates = projects
    .filter((project) => typeof project.root === "string" && project.root.trim() !== "")
    .map((project) => {
      const root = resolve(project.root);
      return {
        projectId: project.project_id,
        projectName: project.project_name,
        root,
      };
    })
    .filter((project) => isInside(target, project.root.toLowerCase()))
    .sort((a, b) => b.root.length - a.root.length);
  return candidates[0];
}

/** Resolve a project by exact name, case-insensitively. */
export function findProjectByName(
  projects: readonly OrcProjectRoot[],
  name: string,
): ProjectMatch | undefined {
  const wanted = name.trim().toLowerCase();
  const project = projects.find((item) => item.project_name.toLowerCase() === wanted);
  return project
    ? {
        projectId: project.project_id,
        projectName: project.project_name,
        root: project.root,
      }
    : undefined;
}
