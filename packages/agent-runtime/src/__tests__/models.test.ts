import { describe, expect, test } from "bun:test";
import { parseAgentModels, readAgentModelCatalog } from "../models";

describe("native model discovery", () => {
  test("validates IDs, hides hidden rows and normalizes labels without exposing extra fields", () => {
    expect(
      parseAgentModels(
        [
          { model: "valid", displayName: "Good\nname", secret: "never-return" },
          { model: "--flag" },
          { model: "hidden", hidden: true },
          { model: "valid", displayName: "Last" },
          null,
        ],
        "codex",
      ),
    ).toEqual([{ id: "valid", label: "Last" }]);
    expect(parseAgentModels([{ value: "sonnet", displayName: "Sonnet" }], "claude")).toEqual([
      { id: "sonnet", label: "Sonnet" },
    ]);
  });

  test("Codex initializes and pages model/list without starting any turns", async () => {
    const script = `let initialized=false;for await(const chunk of Bun.stdin.stream()){for(const line of new TextDecoder().decode(chunk).trim().split("\\n")){const m=JSON.parse(line);if(m.method==="initialize")console.log(JSON.stringify({id:m.id,result:{}}));else if(m.method==="initialized")initialized=true;else if(m.method==="model/list"&&initialized&&m.params.includeHidden===false)console.log(JSON.stringify({id:m.id,result:{data:[{model:m.params.cursor?"second":"first",displayName:"Native model"}],nextCursor:m.params.cursor?null:"page2"}}));else throw Error("Unexpected inference or invalid handshake");}}`;
    expect(
      await readAgentModelCatalog(
        "codex",
        { kind: "local" },
        [process.execPath, "-e", script],
        process.cwd(),
      ),
    ).toEqual([
      { id: "first", label: "Native model" },
      { id: "second", label: "Native model" },
    ]);
  });

  test("Claude returns initialization model metadata without a user message", async () => {
    const script = `for await(const chunk of Bun.stdin.stream()){const m=JSON.parse(new TextDecoder().decode(chunk));if(m.type!=="control_request"||m.request.subtype!=="initialize")throw Error("Unexpected user prompt");console.log(JSON.stringify({type:"control_response",response:{request_id:m.request_id,subtype:"success",response:{models:[{value:"sonnet",displayName:"Sonnet"}]}}}));}`;
    expect(
      await readAgentModelCatalog(
        "claude",
        { kind: "local" },
        [process.execPath, "-e", script],
        process.cwd(),
      ),
    ).toEqual([{ id: "sonnet", label: "Sonnet" }]);
  });

  test("early exit and excessive protocol output fail cleanly", async () => {
    await expect(
      readAgentModelCatalog(
        "codex",
        { kind: "local" },
        [process.execPath, "-e", "process.exit(0)"],
        process.cwd(),
      ),
    ).rejects.toThrow("closed before");
    await expect(
      readAgentModelCatalog(
        "codex",
        { kind: "local" },
        [process.execPath, "-e", 'console.log("x".repeat(1024*1024+1));setInterval(()=>{},1000)'],
        process.cwd(),
      ),
    ).rejects.toThrow("size limit");
  });
});
