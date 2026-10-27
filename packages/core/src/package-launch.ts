import { createHash } from "node:crypto";
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
import { validatePluginMcp } from "./plugin-service.js";
import type { AgentFull, PackageFull } from "./primitive-types.js";
import { readSkillFile } from "./skill-files.js";
import { parseFrontmatter } from "./skill-service.js";

export const AgentSetupSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    packages: z.array(z.string().min(1).max(200)).max(32),
    backend: z.enum(["claude", "codex", "copilot"]),
    tool: z.enum(["apm", "skills"]).default("apm"),
    cwd: z.string().min(1).max(4096),
    agent: z.string().min(1).max(200).optional(),
    model: z.string().min(1).max(200).optional(),
    prompt: z.string().max(16000).default(""),
    operation: z.enum(["run", "install"]).optional(),
    host: z
      .string()
      .max(255)
      .regex(/^[A-Za-z0-9_.@][A-Za-z0-9_.@-]*$/)
      .nullable()
      .optional(),
  })
  .strict()
  .refine(
    (value) => value.packages.length > 0 || Boolean(value.agent),
    "Choose a package or agent",
  );
export type AgentSetup = z.infer<typeof AgentSetupSchema>;
export type PackageStep = {
  argv: string[];
  cwd: string;
  timeout: number | null;
  apmDependencies?: string[];
  apmManagedSources?: { root: string; packages: string[] };
  expectedPlugins?: string[];
  files?: { path: string; content: string; encoding: "utf8" | "base64" }[];
  codexPlugins?: { marketplace: string; plugins: { name: string; mcpServers: string[] }[] };
};
export type PackagePlan = {
  setup: AgentSetup;
  steps: PackageStep[];
  notice: string;
};

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
  writeFileSync(path, JSON.stringify(setup, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
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
  resolved?: {
    cwd: string;
    packages: PackageFull[];
    profile: AgentFull | null;
    files: Map<string, { content: string; encoding: "utf8" | "base64" }>;
    join: typeof join;
    apmSourceRoot?: string;
  },
): PackagePlan {
  const setup = AgentSetupSchema.parse(input);
  const cwd = resolved?.cwd ?? resolve(setup.cwd);
  const pathJoin = resolved?.join ?? join;
  if (!resolved && (!existsSync(cwd) || !statSync(cwd).isDirectory()))
    throw new ValidationError("Choose an existing project folder");
  const packages =
    resolved?.packages ??
    [...new Set(setup.packages)].map((name) => {
      const pkg = readPackage(name);
      if (!pkg) throw new NotFoundError("Package", name);
      return pkg;
    });
  const nativeCodex =
    setup.tool === "apm" &&
    setup.backend === "codex" &&
    packages.some((pkg) => pkg.format === "agent-plugin");
  const needsTool = packages.some((pkg) => !nativeCodex || pkg.format !== "agent-plugin");
  const command = tools[setup.tool];
  if (needsTool && !command)
    throw new ValidationError(
      setup.tool === "apm"
        ? "Install apm-cli 0.33.0 or newer and set ORC_APM_PATH if it is not on PATH"
        : "Install Node.js 22.20 or newer for the bundled Vercel skills CLI",
    );
  const binary = setup.operation === "install" && !nativeCodex ? null : which(setup.backend);
  if ((setup.operation !== "install" || nativeCodex) && !binary)
    throw new ValidationError(`${setup.backend} is not installed or not on PATH`);
  if (needsTool && command) qualify(command, setup.tool === "apm" ? "0.33.0" : "1.7.2");
  if (nativeCodex && binary) qualify([binary], "0.162.1");
  if (setup.backend === "copilot" && binary) qualify([binary], "1.0.81");
  const steps: PackageStep[] = [];
  const deployedSkillNames = new Set<string>();
  if (
    !resolved &&
    setup.backend === "copilot" &&
    setup.tool === "apm" &&
    packages.some((pkg) => pkg.format === "agent-plugin")
  ) {
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
    if (pkg.format === "agent-plugin" && nativeCodex) continue;
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
            ...(command ?? []),
            "add",
            pathJoin(pkg.path, "skills", name),
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
  if (nativeCodex) {
    const plugins = packages.filter((pkg) => pkg.format === "agent-plugin");
    const expectedMcp = plugins.map((pkg) => {
      const file = pkg.files.find((file) => file.name === "mcp.json");
      if (!file) return { name: pkg.name, mcpServers: [] };
      const content =
        resolved?.files.get(`${pkg.name}/mcp.json`) ?? readSkillFile(pkg.path, file.name, false);
      validatePluginMcp([
        { path: "mcp.json", content: content.content, encoding: content.encoding },
      ]);
      return {
        name: pkg.name,
        mcpServers: Object.keys(
          JSON.parse(Buffer.from(content.content, content.encoding).toString("utf8")).mcpServers,
        ),
      };
    });
    const marketplace = `orc-${createHash("sha256")
      .update(JSON.stringify([cwd, plugins.map((pkg) => pkg.name).sort()]))
      .digest("hex")
      .slice(0, 16)}`;
    const root = pathJoin(cwd, ".orc", "plugin-marketplaces", marketplace);
    const files: NonNullable<PackageStep["files"]> = [];
    const sources = new Map<string, string>();
    for (const pkg of plugins) {
      const snapshot = pkg.files
        .map((file) => {
          const content =
            resolved?.files.get(`${pkg.name}/${file.name}`) ??
            readSkillFile(pkg.path, file.name, false);
          return { name: file.name, content: content.content, encoding: content.encoding };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      const digest = createHash("sha256")
        .update(JSON.stringify([pkg.content, snapshot]))
        .digest("hex");
      const relative = `./snapshots/${digest}/plugins/${pkg.name}`;
      sources.set(pkg.name, relative);
      const pluginRoot = pathJoin(root, relative);
      files.push({
        path: pathJoin(pluginRoot, pkg.manifestFile),
        content: pkg.content,
        encoding: "utf8",
      });
      for (const file of snapshot) {
        files.push({
          path: pathJoin(pluginRoot, file.name),
          content: file.content,
          encoding: file.encoding,
        });
      }
    }
    files.push({
      path: pathJoin(root, ".agents", "plugins", "marketplace.json"),
      encoding: "utf8",
      content: JSON.stringify({
        name: marketplace,
        plugins: plugins.map((pkg) => ({
          name: pkg.name,
          source: { source: "local", path: sources.get(pkg.name) },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Productivity",
        })),
      }),
    });
    steps.push({
      argv: [binary as string, "plugin", "marketplace", "add", root],
      cwd,
      timeout: 300000,
      files,
    });
    for (const pkg of plugins)
      steps.push({
        argv: [binary as string, "plugin", "add", `${pkg.name}@${marketplace}`],
        cwd,
        timeout: 300000,
      });
    const last = steps.at(-1);
    if (last && expectedMcp.some((plugin) => plugin.mcpServers.length))
      last.codexPlugins = {
        marketplace: pathJoin(root, ".agents", "plugins", "marketplace.json"),
        plugins: expectedMcp.filter((plugin) => plugin.mcpServers.length),
      };
  }
  const apmPackages = packages.filter((pkg) => !(nativeCodex && pkg.format === "agent-plugin"));
  if (setup.tool === "apm" && apmPackages.length) {
    // One install invocation gives upstream APM one dependency/ownership graph.
    // It owns resolution, locking, target projection and admission gates.
    steps.push({
      argv: [...(command ?? []), "install", "--target", setup.backend],
      cwd,
      timeout: 300000,
      apmDependencies: apmPackages.map((pkg) => pkg.path),
      ...(resolved?.apmSourceRoot
        ? {
            apmManagedSources: {
              root: resolved.apmSourceRoot,
              packages: apmPackages.map((pkg) => pkg.name),
            },
          }
        : {}),
      expectedPlugins: apmPackages
        .filter((pkg) => pkg.format === "agent-plugin")
        .map((pkg) => pkg.name),
    });
    if (setup.backend === "codex")
      steps.push({
        argv: [...(command ?? []), "compile", "--target", "codex"],
        cwd,
        timeout: 300000,
      });
  }
  if (setup.operation === "install")
    return {
      setup: { ...setup, cwd },
      steps,
      notice:
        "Applies selected agent configuration on this host. APM configuration stays in the working folder; native Codex plugins stay installed in Codex's user cache.",
    };
  const argv = [binary as string];
  const profile = resolved ? resolved.profile : setup.agent ? readAgent(setup.agent, cwd) : null;
  if (setup.agent && !profile) throw new NotFoundError("Agent", setup.agent);
  if (profile?.fields.tools !== undefined && setup.backend !== "claude")
    throw new ValidationError(
      "Explicit agent profiles currently require Claude terminals to enforce their model and tool configuration",
    );
  const model =
    setup.model ?? (typeof profile?.fields.model === "string" ? profile.fields.model : undefined);
  if (model) argv.push("--model", model);
  if (profile) {
    if (setup.backend === "claude")
      argv.push("--append-system-prompt", renderAgentInstructions(profile));
    else if (setup.backend === "codex")
      argv.push("-c", `developer_instructions=${JSON.stringify(renderAgentInstructions(profile))}`);
    else throw new ValidationError("Agent profiles currently support Claude and Codex launches");
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
      "Applies the selected configuration on this host before starting the agent. APM keeps configuration in the working folder; native Codex plugins remain in Codex's user cache. Upstream tools may ask about trust or file conflicts in the terminal.",
  };
}

export function packagePlanArgv(plan: PackagePlan, bun: string): string[] {
  // Values are data passed to Bun.spawn, never shell commands or interpolated code.
  const data = JSON.stringify(JSON.stringify(plan.steps));
  const source = `import {existsSync,lstatSync,readFileSync,writeFileSync} from "node:fs";
import {join,dirname} from "node:path";
const steps=JSON.parse(${data});
async function verifyCodexPlugins(step){
 const proc=Bun.spawn([step.argv[0],"app-server","--listen","stdio://"],{cwd:step.cwd,stdin:"pipe",stdout:"pipe",stderr:"ignore",timeout:30000});
 const calls=new Map();let seq=0;
 const request=(method,params)=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{calls.delete(id);reject(Error("Codex plugin verification timed out"));},10000);calls.set(id,{resolve,reject,timer});proc.stdin.write(JSON.stringify({id,method,params})+"\\n");});
 void(async()=>{let buffer="";for await(const chunk of proc.stdout){buffer+=new TextDecoder().decode(chunk);if(buffer.length>2000000)throw Error("Codex plugin metadata exceeded limit");let at;while((at=buffer.indexOf("\\n"))>=0){const value=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);const call=calls.get(value.id);if(call){calls.delete(value.id);clearTimeout(call.timer);if(value.error)call.reject(Error("Codex could not read selected plugin metadata"));else call.resolve(value.result);}}}for(const call of calls.values()){clearTimeout(call.timer);call.reject(Error("Codex plugin verification ended early"));}})().catch(()=>{for(const call of calls.values()){clearTimeout(call.timer);call.reject(Error("Invalid Codex plugin metadata"));}});
 try{
  await request("initialize",{clientInfo:{name:"orc-package-check",version:"1"},capabilities:{experimentalApi:true}});
  proc.stdin.write(JSON.stringify({method:"initialized"})+"\\n");
  for(const plugin of step.codexPlugins.plugins){const result=await request("plugin/read",{marketplacePath:step.codexPlugins.marketplace,pluginName:plugin.name});const missing=plugin.mcpServers.filter(name=>!result.plugin?.mcpServers?.includes(name));if(missing.length)throw Error("Codex did not load selected MCP servers for "+plugin.name+": "+missing.join(", ")+". Check the plugin transport and Codex compatibility.");}
 }finally{proc.kill();for(const call of calls.values())clearTimeout(call.timer);}
}
for(const step of steps){
 for(const file of step.files??[]){
  const parent=dirname(file.path);const fs=await import("node:fs");
  let current=parent;while(true){if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw Error("Package destination cannot contain symlinks");const next=dirname(current);if(next===current)break;current=next;}
  fs.mkdirSync(parent,{recursive:true,mode:0o700});
  if(existsSync(file.path)&&lstatSync(file.path).isSymbolicLink())throw Error("Package destination cannot be a symlink");
  writeFileSync(file.path,Buffer.from(file.content,file.encoding),{mode:0o600});
 }
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
  const managed=step.apmManagedSources;
  const retained=managed?prior.filter(value=>{
   if(typeof value!=="string"||!value.startsWith(managed.root+"/"))return true;
   const parts=value.slice(managed.root.length+1).split("/");
   return parts.length!==2||!(/^[0-9A-HJKMNP-TV-Z]{26}$/).test(parts[0])||!managed.packages.includes(parts[1]);
  }):prior;
  const next=[...retained,...step.apmDependencies.filter(path=>!retained.includes(path))];
  if(JSON.stringify(next)!==JSON.stringify(prior)){
   manifest.dependencies.apm=next;
   if(existsSync(path)&&readFileSync(path,"utf8")!==original)throw Error("apm.yml changed; retry the launch");
   writeFileSync(path,Bun.YAML.stringify(manifest),{flag:original===null?"wx":"w"});
   console.log("[ORC] Added selected package dependencies to apm.yml (existing configuration retained).");
  }
 }
 const child=Bun.spawn(step.argv,{cwd:step.cwd,stdin:"inherit",stdout:"inherit",stderr:"inherit",...(step.timeout?{timeout:step.timeout}:{})});
 const code=await child.exited;if(code!==0){console.error("[ORC] Step failed; agent launch stopped.");process.exit(code||1);}
 if(step.codexPlugins)await verifyCodexPlugins(step);
 if(step.expectedPlugins?.length){
  const settings=JSON.parse(readFileSync(join(step.cwd,".github","copilot","settings.local.json"),"utf8"));
  const catalog=JSON.parse(readFileSync(join(step.cwd,"apm_modules",".github","plugin","marketplace.json"),"utf8"));
  for(const name of step.expectedPlugins){
   if(settings.enabledPlugins?.[name+"@apm"]!==true||!catalog.plugins?.some(plugin=>plugin.name===name))throw Error("APM did not admit/register selected plugin: "+name+". Check its target and security policy before launching.");
  }
 }
}`;
  return [bun, "--eval", source];
}
