import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { readAgent, renderAgentInstructions } from "./agent-service.js";
import { ConflictError, NotFoundError, ValidationError } from "./errors.js";
import { readPackage } from "./package-service.js";
import { readSkillFile } from "./skill-files.js";
import { parseFrontmatter } from "./skill-service.js";

export const AgentSetupSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    packages: z.array(z.string().min(1).max(200)).min(1).max(32),
    backend: z.enum(["claude", "codex", "copilot"]),
    tool: z.enum(["apm", "skills"]).default("apm"),
    cwd: z.string().min(1).max(4096),
    agent: z.string().min(1).max(200).optional(),
    model: z.string().min(1).max(200).optional(),
    prompt: z.string().max(16000).default(""),
  })
  .strict();
export type AgentSetup = z.infer<typeof AgentSetupSchema>;
export type PackageStep = {
  argv: string[];
  cwd: string;
  timeout: number | null;
  apmDependencies?: string[];
};
export type PackagePlan = { setup: AgentSetup; steps: PackageStep[]; notice: string };

export function resolvePackageAgentBinary(name: string): string | null {
  if (name === "copilot" && process.env.ORC_COPILOT_PATH) {
    const path = resolve(process.env.ORC_COPILOT_PATH);
    return existsSync(path) ? path : null;
  }
  return Bun.which(name, { PATH: process.env.PATH ?? "" });
}

export function packageToolCommands(): {
  apm: string[] | null;
  skills: string[] | null;
  bun: string | null;
} {
  const which = (name: string) => Bun.which(name, { PATH: process.env.PATH ?? "" });
  const apm = process.env.ORC_APM_PATH ? resolve(process.env.ORC_APM_PATH) : which("apm");
  const bun = which("bun");
  let skills: string[] | null = null;
  const override = process.env.ORC_SKILLS_PATH;
  if (override && existsSync(override)) skills = [resolve(override)];
  else {
    try {
      const manifest = fileURLToPath(import.meta.resolve("skills/package.json"));
      const entry = join(dirname(manifest), "bin", "cli.mjs");
      const node = which("node");
      if (node && existsSync(entry)) skills = [node, entry];
    } catch {
      /* Standalone builds can use a CLI on PATH or an override. */
    }
    if (!skills) {
      const path = which("skills");
      if (path) skills = [path];
    }
  }
  return { apm: apm && existsSync(apm) ? [apm] : null, skills, bun };
}

const setupRoot = () => join(homedir(), ".orc", "agent-setups");

export function listAgentSetups(root = setupRoot()): {
  setups: AgentSetup[];
  broken: { path: string; error: string }[];
} {
  const setups: AgentSetup[] = [];
  const broken: { path: string; error: string }[] = [];
  if (!existsSync(root)) return { setups, broken };
  if (lstatSync(root).isSymbolicLink())
    throw new ValidationError("Agent setup directory cannot be a symlink");
  for (const file of readdirSync(root, { withFileTypes: true })) {
    if (!file.isFile() || file.isSymbolicLink() || !file.name.endsWith(".json")) continue;
    try {
      if (statSync(join(root, file.name)).size > 65536) throw new Error("Oversized setup");
      setups.push(AgentSetupSchema.parse(JSON.parse(readFileSync(join(root, file.name), "utf8"))));
    } catch {
      broken.push({ path: file.name, error: "Invalid saved agent setup" });
    }
  }
  return { setups, broken };
}

export function saveAgentSetup(input: AgentSetup, root = setupRoot()): AgentSetup {
  const setup = AgentSetupSchema.parse(input);
  if (existsSync(root) && lstatSync(root).isSymbolicLink())
    throw new ValidationError("Agent setup directory cannot be a symlink");
  mkdirSync(root, { recursive: true });
  const path = join(root, `${setup.name}.json`);
  if (existsSync(path)) throw new ConflictError(`Agent setup already exists: ${setup.name}`);
  writeFileSync(path, JSON.stringify(setup, null, 2), { mode: 0o600, flag: "wx" });
  return setup;
}

export function qualifyPackageCommand(argv: string[], minimum: string): void {
  const result = Bun.spawnSync([...argv, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10000,
  });
  const version = new TextDecoder().decode(result.stdout).match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
  if (result.exitCode !== 0 || !version || !Bun.semver.satisfies(version, `>=${minimum}`))
    throw new ValidationError(`Package launch requires ${argv[0]} version ${minimum} or newer`);
}

export function buildPackagePlan(
  input: AgentSetup,
  tools = packageToolCommands(),
  which = resolvePackageAgentBinary,
  qualify = qualifyPackageCommand,
): PackagePlan {
  const setup = AgentSetupSchema.parse(input);
  const cwd = resolve(setup.cwd);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory())
    throw new ValidationError("Choose an existing project folder");
  const packages = [...new Set(setup.packages)].map((name) => {
    const pkg = readPackage(name);
    if (!pkg) throw new NotFoundError("Package", name);
    return pkg;
  });
  const command = tools[setup.tool];
  if (!command)
    throw new ValidationError(
      setup.tool === "apm"
        ? "Install apm-cli 0.33.0 or newer and set ORC_APM_PATH if it is not on PATH"
        : "Install Node.js 22.20 or newer for the bundled Vercel skills CLI",
    );
  const binary = which(setup.backend);
  if (!binary) throw new ValidationError(`${setup.backend} is not installed or not on PATH`);
  if (setup.tool === "apm") qualify(command, "0.33.0");
  else qualify(command, "1.7.2");
  if (setup.backend === "copilot") qualify([binary], "1.0.81");
  const steps: PackageStep[] = [];
  const deployedSkillNames = new Set<string>();
  if (setup.tool === "apm" && packages.some((pkg) => pkg.format === "agent-plugin")) {
    const git = Bun.which("git");
    if (!git) throw new ValidationError("Portable plugin activation requires Git");
    const result = Bun.spawnSync([git, "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10000,
    });
    const root = new TextDecoder().decode(result.stdout).trim();
    const normalize = (path: string) =>
      process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
    if (result.exitCode !== 0 || normalize(root) !== normalize(cwd))
      throw new ValidationError(
        "Choose the Git repository root so Copilot loads APM's project registration",
      );
  }
  for (const pkg of packages) {
    if (pkg.format === "agent-plugin" && setup.tool === "apm" && setup.backend !== "copilot")
      throw new ValidationError(
        "APM activates portable Agent Plugins natively for Copilot. Choose Copilot, or use Vercel skills for a skills-only package.",
      );
    if (setup.tool === "skills") {
      if (pkg.format !== "agent-plugin" || pkg.files.some((file) => file.name === "mcp.json"))
        throw new ValidationError(
          "Vercel skills runs skills-only Agent Plugins; use APM for packages with MCP or APM primitives",
        );
      const skills = pkg.files.flatMap((file) => {
        const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(file.name);
        if (!match) return [];
        try {
          const { frontmatter } = parseFrontmatter(
            readSkillFile(pkg.path, file.name, false).content,
          );
          return frontmatter.name === match[1] ? [frontmatter.name] : [];
        } catch {
          return [];
        } // Invalid components stay inspectable but do not deploy.
      });
      if (!skills.length) throw new ValidationError(`Package ${pkg.name} has no skills to deploy`);
      for (const name of skills) {
        if (deployedSkillNames.has(name))
          throw new ValidationError(`Selected packages contain the same skill name: ${name}`);
        deployedSkillNames.add(name);
        steps.push({
          argv: [
            ...command,
            "add",
            join(pkg.path, "skills", name),
            "--agent",
            setup.backend === "claude"
              ? "claude-code"
              : setup.backend === "copilot"
                ? "github-copilot"
                : setup.backend,
            "--copy",
          ],
          cwd,
          timeout: 300000,
        });
      }
    }
  }
  if (setup.tool === "apm") {
    // One install invocation gives upstream APM one dependency/ownership graph.
    // It owns resolution, locking, target projection and admission gates.
    steps.push({
      argv: [...command, "install", "--target", setup.backend],
      cwd,
      timeout: 300000,
      apmDependencies: packages.map((pkg) => pkg.path),
    });
  }
  const argv = [binary];
  const profile = setup.agent ? readAgent(setup.agent, cwd) : null;
  if (setup.agent && !profile) throw new NotFoundError("Agent", setup.agent);
  if (profile && setup.backend !== "claude")
    throw new ValidationError(
      "Explicit agent profiles currently require Claude terminals to enforce their model and tool configuration",
    );
  const model =
    setup.model ?? (typeof profile?.fields.model === "string" ? profile.fields.model : undefined);
  if (model) argv.push("--model", model);
  if (profile) {
    argv.push("--append-system-prompt", renderAgentInstructions(profile));
    const tools = profile.fields.tools;
    if (tools !== undefined) {
      const allowed =
        typeof tools === "string"
          ? tools.split(/[\s,]+/).filter(Boolean)
          : Array.isArray(tools)
            ? tools
            : Object.entries(tools)
                .filter(([, allowed]) => allowed)
                .map(([name]) => name);
      argv.push("--tools", allowed.join(","));
    }
  }
  if (setup.prompt) {
    if (setup.backend === "copilot") argv.push("--interactive", setup.prompt);
    else argv.push("--", setup.prompt);
  }
  steps.push({ argv, cwd, timeout: null });
  return {
    setup: { ...setup, cwd },
    steps,
    notice:
      "Deploys selected packages into this project using upstream tooling. APM adds dependencies to apm.yml while retaining existing configuration. Project configuration remains after this session; upstream tools may ask about trust or file conflicts in the terminal.",
  };
}

export function packagePlanArgv(plan: PackagePlan, bun: string): string[] {
  // Values are data passed to Bun.spawn, never shell commands or interpolated code.
  const data = JSON.stringify(JSON.stringify(plan.steps));
  const source = `import {existsSync,lstatSync,readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
const steps=JSON.parse(${data});
for(const step of steps){
 console.log("\\n[ORC] "+(step.timeout ? "Preparing packages" : "Starting agent"));
 if(step.apmDependencies){
  const path=join(step.cwd,"apm.yml");
  if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw Error("apm.yml cannot be a symlink");
  const original=existsSync(path)?readFileSync(path,"utf8"):null;
  const manifest=original===null?{name:"orc-agent-setup",version:"1.0.0"}:Bun.YAML.parse(original);
  const object=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
  if(!object(manifest)|| (manifest.dependencies!==undefined&&!object(manifest.dependencies)))throw Error("Invalid project apm.yml; fix it before launching");
  manifest.dependencies??={};
  const prior=manifest.dependencies.apm??[];
  if(!Array.isArray(prior))throw Error("apm.yml dependencies.apm must be an array");
  const added=step.apmDependencies.filter(path=>!prior.includes(path));
  if(added.length){
   manifest.dependencies.apm=[...prior,...added];
   if(existsSync(path)&&readFileSync(path,"utf8")!==original)throw Error("apm.yml changed; retry the launch");
   writeFileSync(path,Bun.YAML.stringify(manifest),{flag:original===null?"wx":"w"});
   console.log("[ORC] Added selected package dependencies to apm.yml (existing configuration retained).");
  }
 }
 const child=Bun.spawn(step.argv,{cwd:step.cwd,stdin:"inherit",stdout:"inherit",stderr:"inherit",...(step.timeout?{timeout:step.timeout}:{})});
 const code=await child.exited;if(code!==0){console.error("[ORC] Step failed; agent launch stopped.");process.exit(code||1);}
}`;
  return [bun, "--eval", source];
}
