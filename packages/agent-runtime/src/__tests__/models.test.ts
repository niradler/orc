import { describe, expect, test } from "bun:test";
import {
  informativeDescription,
  parseAgentModels,
  readAgentModelCatalog,
  readTextModelCatalog,
} from "../models";
import claudeModels from "./fixtures/claude-initialize-models.json";
import codexModels from "./fixtures/codex-model-list.json";

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

  test("keeps descriptions and supported efforts from real Claude and Codex catalogs", () => {
    const claude = parseAgentModels(claudeModels, "claude");
    expect(claude.map((model) => model.id)).toEqual(["default", "sonnet", "haiku"]);
    expect(claude.find((model) => model.id === "sonnet")).toEqual({
      id: "sonnet",
      label: "Sonnet",
      description: "Sonnet 5 · Efficient for routine tasks",
      efforts: ["low", "medium", "high", "xhigh", "max"],
    });
    expect(claude.find((model) => model.id === "haiku")).toEqual({
      id: "haiku",
      label: "Haiku",
      description: "Haiku 4.5 · Fastest for quick answers",
    });
    expect(parseAgentModels(codexModels.data, "codex")).toEqual([
      {
        id: "gpt-6.1-sol",
        label: "GPT-6.1-Sol",
        description: "Latest workhorse model for coding and everyday work.",
        efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      },
      {
        id: "gpt-6.1-terra",
        label: "GPT-6.1 Terra",
        efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      },
      {
        id: "gpt-6-luna",
        label: "GPT-6-Luna",
        description: "Fast and affordable model for easier tasks.",
        efforts: ["low", "medium", "high", "xhigh", "max"],
      },
    ]);
    expect(
      parseAgentModels(
        [{ value: "x", supportedEffortLevels: ["low", "--bad", 3, "x y"], description: 7 }],
        "claude",
      ),
    ).toEqual([{ id: "x", label: "x", efforts: ["low"] }]);
  });

  test("hides a description that only restates the model name", () => {
    expect(informativeDescription("GPT-6.1 Terra Codex model.", "GPT-6.1 Terra", "codex")).toBe("");
    expect(informativeDescription("Sonnet", "Sonnet", "claude")).toBe("");
    expect(
      informativeDescription("Sonnet 5 · Efficient for routine tasks", "Sonnet", "claude"),
    ).toBe("Sonnet 5 · Efficient for routine tasks");
    expect(informativeDescription("Haiku 4.5", "Haiku", "claude")).toBe("Haiku 4.5");
    expect(informativeDescription("最速のモデル", "Fast", "pi")).toBe("最速のモデル");
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

  test("OpenCode text catalog validates ids, drops junk and deduplicates", async () => {
    const script = `console.log("provider/model-a");console.log("provider/model-a");console.log("--flag");console.log("");console.log("has space");console.log("custom-provider/example-model");`;
    expect(
      await readTextModelCatalog(
        { kind: "local" },
        [process.execPath, "-e", script],
        process.cwd(),
      ),
    ).toEqual([
      { id: "provider/model-a", label: "provider/model-a" },
      { id: "custom-provider/example-model", label: "custom-provider/example-model" },
    ]);
  });

  test("text catalog output beyond the size limit fails cleanly", async () => {
    await expect(
      readTextModelCatalog(
        { kind: "local" },
        [process.execPath, "-e", 'console.log("x".repeat(1024*1024+1));setInterval(()=>{},1000)'],
        process.cwd(),
      ),
    ).rejects.toThrow("size limit");
  });

  test("should reject failed OpenCode discovery even when it printed a partial catalog", async () => {
    await expect(
      readTextModelCatalog(
        { kind: "local" },
        [process.execPath, "-e", 'console.log("custom-provider/example-model");process.exit(1)'],
        process.cwd(),
      ),
    ).rejects.toThrow("could not list its models");
  });
});
