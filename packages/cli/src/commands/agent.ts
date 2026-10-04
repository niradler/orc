import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseAgent } from "@orc/core/agent-service";
import { parseApmManifest } from "@orc/core/package-service";
import { encodeSkillFile, listSkillFiles, validateSkillPath } from "@orc/core/skill-files";
import { createOrcClient } from "@orc/sdk/client";
import type { PackageFull, SkillRefContent } from "@orc/sdk/types";
import { Command } from "commander";
import { isJson, jsonOut } from "../output.js";

export function agentCommand(): Command {
  const command = new Command("agent").description(
    "Share APM .agent.md profiles across coding backends",
  );
  command.command("list").action(async () => {
    const { data, error } = await createOrcClient().agents.list();
    if (error) throw new Error(JSON.stringify(error));
    if (isJson()) return jsonOut(data);
    for (const agent of data?.agents ?? [])
      console.log(`${agent.id} [${agent.source}] ${agent.description}`);
    for (const issue of data?.broken ?? []) console.error(`${issue.path}: ${issue.error}`);
  });
  command.command("read <id>").action(async (id: string) => {
    const { data, error } = await createOrcClient().agents.read(id);
    if (error || !data) throw new Error(JSON.stringify(error));
    if (isJson()) return jsonOut(data);
    console.log(data.raw);
  });
  command
    .command("create <id>")
    .requiredOption("-f, --file <path>", "APM .agent.md file")
    .action(async (id: string, opts: { file: string }) => {
      const content = readFileSync(opts.file, "utf8");
      parseAgent(content, `${id}.agent.md`);
      const { data, error } = await createOrcClient().agents.create({ id, content });
      if (error || !data) throw new Error(JSON.stringify(error));
      if (isJson()) return jsonOut(data);
      console.log(`Created shared agent ${data.id} at ${data.path}`);
    });
  command
    .command("export <id> <file>")
    .description("Export the original APM .agent.md definition")
    .action(async (id: string, file: string) => {
      const { data, error } = await createOrcClient().agents.read(id);
      if (error || !data) throw new Error(JSON.stringify(error));
      if (!file.endsWith(".agent.md")) throw new Error("Output file must end in .agent.md");
      const path = resolve(file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, data.raw, { encoding: "utf8", flag: "wx" });
      console.log(`Exported ${data.id} to ${path}`);
    });
  return command;
}

export function agentPackageCommand(): Command {
  const command = new Command("agent-package").description(
    "Import/export intact APM packages shared by all coding agents",
  );
  command.command("list").action(async () => {
    const { data, error } = await createOrcClient().agentPackages.list();
    if (error) throw new Error(JSON.stringify(error));
    if (isJson()) return jsonOut(data);
    for (const pkg of data?.packages ?? []) console.log(`${pkg.name}@${pkg.version} ${pkg.path}`);
    for (const issue of data?.broken ?? []) console.error(`${issue.path}: ${issue.error}`);
  });
  command
    .command("import <directory>")
    .description("Validate and share an apm.yml package with every bundled file")
    .action(async (directory: string) => {
      const content = readFileSync(join(directory, "apm.yml"), "utf8");
      const manifest = parseApmManifest(content);
      const files = listSkillFiles(directory, "apm.yml").map((file) => ({
        path: file.name,
        ...encodeSkillFile(readFileSync(file.path)),
      }));
      const { data, error } = await createOrcClient().agentPackages.create({
        name: manifest.name,
        content,
        files,
      });
      if (error || !data) throw new Error(JSON.stringify(error));
      if (isJson()) return jsonOut(data);
      console.log(
        `Shared ${data.name}@${data.version}: ${data.files.length} supporting files at ${data.path}`,
      );
    });
  command
    .command("export <name> <directory>")
    .description("Export the intact package for APM and other coding tools")
    .action(async (name: string, directory: string) => {
      const client = createOrcClient();
      const { data, error } = await client.agentPackages.read(name);
      if (error || !data) throw new Error(JSON.stringify(error));
      const pkg = data as PackageFull;
      const files = await Promise.all(
        pkg.files.map(async (file) => {
          validateSkillPath(file.name);
          const result = await client.agentPackages.read(name, file.name);
          if (result.error || !result.data) throw new Error(JSON.stringify(result.error));
          return { path: file.name, data: result.data as SkillRefContent };
        }),
      );
      const root = resolve(directory);
      if (existsSync(root))
        throw new Error("Export destination already exists; choose a new directory");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "apm.yml"), pkg.content, { encoding: "utf8", flag: "wx" });
      for (const file of files) {
        const path = join(root, file.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, Buffer.from(file.data.content, file.data.encoding), { flag: "wx" });
      }
      console.log(`Exported ${pkg.name} to ${root}`);
    });
  return command;
}
