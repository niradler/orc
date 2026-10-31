import { loadConfig } from "@orc/core/config";
import { ValidationError } from "@orc/core/errors";
import { hostBinary, hostExec, hostIsDirectory } from "@orc/core/exec-host";
import { CommandRunSchema, type HumanRequest } from "@orc/core/human-requests";
import { selectedTerminalHost } from "../terminals/host.js";

// The payload, including secrets, travels on stdin. Nothing sensitive enters argv or files.
const EXECUTE = `import {spawn} from "node:child_process";
const data = await Bun.stdin.json();
const secrets = Object.values(data.values).filter(Boolean).flatMap(value => [
  value, encodeURIComponent(value), Buffer.from(value).toString("base64"),
  JSON.stringify(value).slice(1, -1),
]).sort((a,b) => b.length-a.length);
const redact = text => { for (const secret of secrets) text = text.split(secret).join("[REDACTED]"); return text; };
let truncated = false;
const read = async stream => {
 const decoder = new TextDecoder(); let text = ""; let overflow = false;
 for await (const chunk of stream) {
   if (!overflow) { text += decoder.decode(chunk, {stream:true}); if (text.length > 128000) { text = text.slice(0,128000); overflow = true; truncated = true; } }
 }
 if (overflow) text = text.slice(0, Math.max(0, text.length - Math.max(1, ...secrets.map(s => s.length))));
 else text += decoder.decode();
 const safe = redact(text); if (safe.length > 64000) truncated = true; return safe.slice(0,64000);
};
try {
 const env = {...process.env};
 for (const [name,value] of Object.entries(data.values)) env["ORC_INPUT_"+name] = value;
 const proc = spawn("sh",["-c",data.script], {cwd:data.cwd, env, detached:true, stdio:["ignore","pipe","pipe"]});
 const exited = new Promise((resolve,reject) => {proc.once("error",reject);proc.once("close",code=>resolve(code ?? -1));});
 const stop = () => {try { process.kill(-proc.pid,"SIGKILL"); } catch {}};
 let timedOut = false;
 const timer = setTimeout(() => {timedOut = true;stop();}, data.timeout*1000);
 let stdout,stderr,exit_code;
 try { [stdout,stderr,exit_code] = await Promise.all([read(proc.stdout),read(proc.stderr),exited]); }
 catch (error) {stop();throw error;}
 finally {clearTimeout(timer);}
 if (timedOut) {exit_code = -1;stderr = (stderr + "\\nCommand timed out").slice(0,64000);}
 console.log(JSON.stringify({kind:"command",script:redact(data.script).slice(0,16000),stdout,stderr,exit_code,truncated}));
} catch { console.log(JSON.stringify({kind:"command",script:redact(data.script).slice(0,16000),exit_code:-1,stdout:"",stderr:"Command could not complete. Inspect the execution host before retrying.",truncated})); }`;

export async function prepareCommand(request: HumanRequest, raw: unknown) {
  const run = CommandRunSchema.parse(raw);
  const spec = request.input.command;
  if (request.input.kind !== "command" || !spec)
    throw new ValidationError("This is not a command request");
  if (
    Object.keys(run.values).some((name) => !spec.arguments.some((arg) => arg.name === name)) ||
    spec.arguments.some((arg) => arg.required && !run.values[arg.name])
  )
    throw new ValidationError("Fill the required arguments and use only declared names");
  const host = selectedTerminalHost(loadConfig(), spec.host);
  if (host.kind === "local" && process.platform === "win32")
    throw new ValidationError("Command requests require a POSIX execution host");
  if (!(await hostIsDirectory(host, spec.cwd)))
    throw new ValidationError("The command folder is unavailable on the selected host");
  const bun = await hostBinary(host, "bun");
  if (!bun) throw new ValidationError("Command execution requires Bun on the selected host");
  return {
    execute: async () => {
      try {
        const result = await hostExec(host, [bun, "--eval", EXECUTE], {
          input: JSON.stringify({
            script: run.script,
            cwd: spec.cwd,
            values: run.values,
            timeout: spec.timeout_seconds,
          }),
          timeoutMs: (spec.timeout_seconds + 10) * 1000,
          login: false,
        });
        if (result.code !== 0) throw new Error("Execution transport failed");
        return JSON.parse(result.stdout);
      } catch {
        // Transport errors may contain diagnostics or an indeterminate execution outcome.
        return {
          kind: "command",
          exit_code: -1,
          stdout: "",
          stderr: "Execution result unavailable. Inspect the host before retrying.",
          truncated: false,
        };
      }
    },
  };
}
