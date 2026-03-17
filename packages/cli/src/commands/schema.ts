import { loadConfig } from "@orc/core/config";
import { Command } from "commander";

const RESOURCES = ["task", "memory", "job", "project", "prompt", "session"] as const;

function apiBase(): string {
  try {
    const c = loadConfig();
    return `http://${c.api.host}:${c.api.port}`;
  } catch {
    return process.env.ORC_API_BASE ?? "http://127.0.0.1:7700";
  }
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const secret =
    process.env.ORC_API_SECRET ??
    (() => {
      try {
        return loadConfig().api.secret;
      } catch {
        return undefined;
      }
    })();
  if (secret) headers.Authorization = `Bearer ${secret}`;
  return headers;
}

const SCHEMA_MAP: Record<string, string[]> = {
  task: ["Task", "CreateTask", "UpdateTask", "Comment", "TaskLink"],
  memory: ["Memory", "CreateMemory"],
  job: ["Job", "CreateJob", "UpdateJob", "JobRun"],
  project: ["Project", "CreateProject", "UpdateProject"],
  prompt: ["Prompt", "CreatePrompt", "UpdatePrompt"],
  session: ["Session"],
};

export function schemaCommand() {
  const cmd = new Command("schema")
    .description("Show resource schemas from the OpenAPI spec (requires running API)")
    .argument("[resource]", `Resource name: ${RESOURCES.join(", ")}`)
    .option("--list", "List available schema names")
    .action(async (resource?: string, opts?: { list?: boolean }) => {
      let res: Response;
      try {
        res = await fetch(`${apiBase()}/openapi.json`, { headers: authHeaders() });
      } catch {
        return console.error("Cannot connect to orc API. Is it running? (orc api or orc daemon)");
      }

      if (!res.ok) return console.error(`API error: ${res.status}`);
      const spec = (await res.json()) as {
        components?: { schemas?: Record<string, unknown> };
      };
      const schemas = spec.components?.schemas;
      if (!schemas) return console.error("No schemas found in OpenAPI spec.");

      if (opts?.list || !resource) {
        console.log("Available schemas:");
        for (const name of Object.keys(schemas).sort()) {
          console.log(`  ${name}`);
        }
        return;
      }

      const key = resource.toLowerCase();
      const names = SCHEMA_MAP[key];
      if (!names) {
        return console.error(`Unknown resource: ${resource}. Available: ${RESOURCES.join(", ")}`);
      }

      const result: Record<string, unknown> = {};
      for (const name of names) {
        if (schemas[name]) result[name] = schemas[name];
      }

      if (Object.keys(result).length === 0) {
        return console.error(`No schemas found for: ${resource}`);
      }

      console.log(JSON.stringify(result, null, 2));
    });

  return cmd;
}
