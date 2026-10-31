import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetConfig } from "@orc/core/config";
import { AcpxSession } from "../acpx";

test("should inject private ACPX MCP config for prepare, send and resume and clean it after exit", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "orc-acpx-mcp-"));
  const capture = join(cwd, "capture.json");
  const script = join(cwd, "cli.ts");
  writeFileSync(
    script,
    `import {readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2);const path=args[args.indexOf('--mcp-config')+1];
const config=JSON.parse(readFileSync(path,'utf8'));
writeFileSync(${JSON.stringify(capture)},JSON.stringify({args,path,config}));
if(args.includes('ensure')){console.log('{}');process.exit(args.includes('failure')?1:0);}
console.log(JSON.stringify({id:1,result:{stopReason:'end_turn'}}));`,
  );
  const saved = process.env.ORC_API_SECRET;
  process.env.ORC_API_SECRET = "private-fixture-secret";
  resetConfig();
  const session = new AcpxSession(
    { cwd, acpxAgent: "cursor", orcMcp: true, orcMcpProject: "project name" },
    [process.execPath, script],
    { kind: "local" },
  );
  function captured(): {
    args: string[];
    path: string;
    config: {
      mcpServers: Array<{
        name: string;
        type: string;
        url: string;
        headers: Array<{ name: string; value: string }>;
      }>;
    };
  } {
    return JSON.parse(readFileSync(capture, "utf8"));
  }
  try {
    await session.ensureSession();
    const prepare = captured();
    expect(prepare.config.mcpServers).toHaveLength(1);
    expect(prepare.config.mcpServers[0]).toMatchObject({
      name: "orc",
      type: "http",
      headers: [{ name: "Authorization", value: "Bearer private-fixture-secret" }],
    });
    expect(new URL(prepare.config.mcpServers[0]?.url ?? "").searchParams.get("project")).toBe(
      "project name",
    );
    expect(prepare.args).toContain("cursor");
    expect(prepare.args.join(" ")).not.toContain("private-fixture-secret");
    expect(existsSync(prepare.path)).toBe(false);
    for (const prompt of ["first", "follow-up"]) {
      await session.send(prompt);
      for await (const event of session.events()) expect(event.type).toBe("result");
      await session.close();
      expect(existsSync(captured().path)).toBe(false);
      expect(captured().args).toContain(session.getRuntimeSessionId());
    }
    const failed = new AcpxSession(
      { cwd, acpxAgent: "failure", orcMcp: true },
      [process.execPath, script],
      { kind: "local" },
    );
    await expect(failed.ensureSession()).rejects.toThrow("could not prepare");
    expect(existsSync(captured().path)).toBe(false);
    await failed.close();
  } finally {
    await session.close();
    if (saved === undefined) delete process.env.ORC_API_SECRET;
    else process.env.ORC_API_SECRET = saved;
    resetConfig();
    rmSync(cwd, { recursive: true, force: true });
  }
});
