import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpxSession } from "../acpx";

test("should pass ACPX arguments literally and respect explicit permission flags", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "orc-acpx-args-"));
  const script = join(cwd, "agent.ts");
  const ensured = join(cwd, "ensured.json");
  writeFileSync(
    script,
    `import {writeFileSync} from 'node:fs'; if(process.argv.includes('ensure')){writeFileSync(${JSON.stringify(ensured)},JSON.stringify(process.argv.slice(2)));console.log('{}');process.exit(0);}console.log(JSON.stringify({method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(process.argv.slice(2))}}}}));console.log(JSON.stringify({id:1,result:{stopReason:'end_turn'}}));`,
  );
  const policy = '{"autoApprove":["echo $(literal) & quoted"]}';
  const session = new AcpxSession(
    {
      cwd,
      autoApprove: true,
      acpxAgent: "fixture",
      chatAgentOptions: {
        runtime: "acpx",
        args: ["--deny-all", "--timeout=10", "--policy", policy],
      },
    },
    [process.execPath, script],
    { kind: "local" },
  );
  try {
    await session.ensureSession();
    expect(JSON.parse(readFileSync(ensured, "utf8")).slice(-5)).toEqual([
      "fixture",
      "sessions",
      "ensure",
      "--name",
      session.getRuntimeSessionId(),
    ]);
    await session.send("Quoted prompt ' and &");
    let seen = false;
    for await (const event of session.events())
      if (event.type === "text") {
        const values = JSON.parse(event.data) as string[];
        expect(values).toContain("--deny-all");
        expect(values).not.toContain("--approve-all");
        expect(values.indexOf("prompt")).toBeLessThan(values.indexOf("-s"));
        expect(values[values.indexOf("--policy") + 1]).toBe(policy);
        expect(values.at(-1)).toBe("Quoted prompt ' and &");
        expect(values[values.indexOf("-s") + 1]).toBe(session.getRuntimeSessionId());
        seen = true;
      }
    expect(seen).toBe(true);
  } finally {
    await session.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("should load an explicit native ACPX session and reject a replacement identity", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "orc-acpx-native-"));
  const script = join(cwd, "agent.ts");
  const recorded = join(cwd, "argv.json");
  writeFileSync(
    script,
    `import {writeFileSync} from 'node:fs'; const args=process.argv.slice(2);writeFileSync(${JSON.stringify(recorded)},JSON.stringify(args));console.log(JSON.stringify({acpxSessionId:args.includes('cursor')?'original-native':'replacement-native'}));`,
  );
  try {
    for (const agent of ["cursor", "gemini"]) {
      const session = new AcpxSession(
        {
          cwd,
          acpxAgent: agent,
          runtimeSessionId: "original-native",
          acpxNativeSessionId: "original-native",
        },
        [process.execPath, script],
        { kind: "local" },
      );
      try {
        if (agent === "cursor") await session.ensureSession();
        else
          await expect(session.ensureSession()).rejects.toThrow(
            "did not resume the requested native session",
          );
        const args = JSON.parse(readFileSync(recorded, "utf8")) as string[];
        expect(args.slice(-7)).toEqual([
          agent,
          "sessions",
          "ensure",
          "--name",
          "original-native",
          "--resume-session",
          "original-native",
        ]);
        expect(session.getRuntimeSessionId()).toBe("original-native");
      } finally {
        await session.close();
      }
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
