import { resolve, sep } from "node:path";
import type { OrcProjectRoot } from "./api.js";

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
