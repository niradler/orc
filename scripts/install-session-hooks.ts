import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

const Root = z
  .object({ hooks: z.record(z.string(), z.array(z.unknown())).optional() })
  .passthrough();
const command = `"${process.execPath}" "${resolve(import.meta.dir, "../hooks/live-session.ts")}"`;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

function install(path: string, backend: string, events: string[]): void {
  const existingText = existsSync(path) ? readFileSync(path, "utf8") : null;
  const existing = Root.parse(existingText ? JSON.parse(existingText) : {});
  const hooks = existing.hooks ?? {};
  for (const event of events) {
    const hookCommand = `${command} ${backend} ${event}`;
    const previous = hooks[event] ?? [];
    if (
      previous.some(
        (entry) =>
          JSON.stringify(entry).includes("hooks/live-session.ts") ||
          JSON.stringify(entry).includes("hooks\\\\live-session.ts"),
      )
    )
      continue;
    const hook =
      backend === "cursor"
        ? { command: hookCommand, timeout: 5 }
        : {
            hooks: [
              { type: "command", name: "orc-live-session", command: hookCommand, timeout: 5000 },
            ],
          };
    hooks[event] = [...previous, hook];
  }
  mkdirSync(dirname(path), { recursive: true });
  if (existingText) writeFileSync(`${path}.${stamp}.bak`, existingText, { mode: 0o600 });
  writeFileSync(
    path,
    `${JSON.stringify({ ...existing, ...(backend === "cursor" ? { version: 1 } : {}), hooks }, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(`Installed ${backend} session lifecycle hooks: ${path}`);
}

install(join(homedir(), ".cursor/hooks.json"), "cursor", [
  "sessionStart",
  "beforeSubmitPrompt",
  "afterAgentResponse",
  "preToolUse",
  "postToolUse",
  "stop",
  "sessionEnd",
]);
install(join(homedir(), ".gemini/settings.json"), "gemini", [
  "SessionStart",
  "BeforeAgent",
  "BeforeTool",
  "AfterTool",
  "AfterAgent",
  "SessionEnd",
]);
