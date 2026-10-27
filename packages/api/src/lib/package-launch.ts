import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { readAgent } from "@orc/core/agent-service";
import { ValidationError } from "@orc/core/errors";
import { type ExecHost, hostExec, remoteTempPath, writeHostFile } from "@orc/core/exec-host";
import { ulid } from "@orc/core/ids";
import {
  type AgentSetup,
  buildPackagePlan,
  type PackagePlan,
  packagePlanArgv,
  packageToolCommands,
} from "@orc/core/package-launch";
import { readPackage } from "@orc/core/package-service";
import { readSkillFile } from "@orc/core/skill-files";

/** Resolve and prepare on the selected host, never against the API machine's PATH/folders. */
export async function preparePackageLaunch(
  setup: AgentSetup,
  host: ExecHost,
  transport = { exec: hostExec, writeFile: writeHostFile },
): Promise<{ plan: PackagePlan; argv: string[] }> {
  let plan: PackagePlan;
  let bun: string;
  if (host.kind === "local") {
    const tools = packageToolCommands();
    if (!tools.bun) throw new ValidationError("Package preparation needs Bun on the selected host");
    bun = tools.bun;
    plan = buildPackagePlan(setup, tools);
  } else {
    const result = await transport.exec(
      host,
      [
        "bun",
        "--eval",
        `import{statSync}from"node:fs";import{resolve}from"node:path";const cwd=resolve(process.argv[1]);if(!statSync(cwd).isDirectory())throw Error("Choose an existing working folder");const binaries=Object.fromEntries(["bun","apm","codex","claude","copilot","git"].map(name=>[name,Bun.which(name)]));console.log(JSON.stringify({cwd,binaries}));`,
        "--",
        setup.cwd,
      ],
      { timeoutMs: 15000 },
    );
    if (result.code !== 0)
      throw new ValidationError(
        `Cannot prepare packages on ${host.alias}. Check the working folder and that Bun is installed on this host.`,
      );
    const resolved = JSON.parse(result.stdout.trim()) as {
      cwd: string;
      binaries: Record<string, string | null>;
    };
    if (!resolved.binaries.bun)
      throw new ValidationError(`Install Bun on ${host.alias} before using packages`);
    bun = resolved.binaries.bun;
    const packages = [...new Set(setup.packages)].map((name) => {
      const pkg = readPackage(name);
      if (!pkg) throw new ValidationError(`Package not found: ${name}`);
      return pkg;
    });
    const profile = setup.agent ? readAgent(setup.agent) : null;
    if (setup.agent && !profile) throw new ValidationError(`Agent not found: ${setup.agent}`);
    const files = new Map<string, { content: string; encoding: "utf8" | "base64" }>();
    const staged: NonNullable<PackagePlan["steps"][number]["files"]> = [];
    const sourceRoot = posix.join(resolved.cwd, ".orc", "package-sources");
    const root = posix.join(sourceRoot, ulid());
    for (const pkg of packages) {
      staged.push({
        path: posix.join(root, pkg.name, pkg.manifestFile),
        content: pkg.content,
        encoding: "utf8",
      });
      for (const file of pkg.files) {
        const content = readSkillFile(pkg.path, file.name, false);
        files.set(`${pkg.name}/${file.name}`, content);
        staged.push({
          path: posix.join(root, pkg.name, file.name),
          content: content.content,
          encoding: content.encoding,
        });
      }
      pkg.path = posix.join(root, pkg.name);
    }
    const requirements: [string, string][] = [];
    plan = buildPackagePlan(
      setup,
      { apm: resolved.binaries.apm ? [resolved.binaries.apm] : null, skills: null, bun },
      (name) => resolved.binaries[name] ?? null,
      (argv, minimum) => {
        requirements.push([argv[0] as string, minimum]);
      },
      { cwd: resolved.cwd, packages, profile, files, join: posix.join, apmSourceRoot: sourceRoot },
    );
    for (const [binary, minimum] of requirements) {
      const version = await transport.exec(host, [binary, "--version"], { timeoutMs: 10000 });
      const found = version.stdout.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
      if (version.code !== 0 || !found || !Bun.semver.satisfies(found, `>=${minimum}`))
        throw new ValidationError(
          `${host.alias} needs ${posix.basename(binary)} ${minimum} or newer`,
        );
    }
    if (setup.backend === "copilot" && packages.some((pkg) => pkg.format === "agent-plugin")) {
      const git = await transport.exec(
        host,
        [resolved.binaries.git ?? "git", "rev-parse", "--show-toplevel"],
        { cwd: resolved.cwd, timeoutMs: 10000 },
      );
      if (git.code !== 0 || git.stdout.trim() !== resolved.cwd)
        throw new ValidationError(
          "Choose the Git repository root so Copilot loads its plugin registration",
        );
    }
    if (staged.length && plan.steps[0])
      plan.steps[0].files = [...staged, ...(plan.steps[0].files ?? [])];
  }
  const source = packagePlanArgv(plan, bun)[2] as string;
  let script: string;
  if (host.kind === "local") {
    script = join(mkdtempSync(join(tmpdir(), "orc-package-launch-")), "launch.ts");
    writeFileSync(script, source, { mode: 0o600, flag: "wx" });
  } else {
    script = remoteTempPath("-package-launch.ts");
    await transport.writeFile(host, script, source);
  }
  return { plan, argv: [bun, script] };
}

/** Chat has no PTY to answer installer prompts. Fail visibly rather than starting unconfigured. */
export async function installPackageForChat(setup: AgentSetup, host: ExecHost): Promise<string> {
  const { plan, argv } = await preparePackageLaunch({ ...setup, operation: "install" }, host);
  const result = await hostExec(host, argv, { cwd: plan.setup.cwd, timeoutMs: 300000 });
  if (result.code !== 0)
    throw new ValidationError(
      "Package preparation did not finish. Use the terminal option to review installer trust, authentication or file-conflict prompts, then retry chat.",
    );
  return plan.setup.cwd;
}
