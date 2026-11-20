import { isAbsolute } from "node:path";
import variant from "@jitl/quickjs-wasmfile-release-sync";
// Bun's file import keeps the WASM asset available in standalone builds.
// @ts-expect-error Bun resolves this package asset at build time.
import wasmPath from "@jitl/quickjs-wasmfile-release-sync/wasm" with { type: "file" };
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type VmCallResult,
} from "quickjs-emscripten-core";

import { CODE_LIMITS, type CodeOutput, hasBoundedJsonShape } from "./code-protocol.js";

const bootstrap = `
  ((rpc, log) => {
    "use strict";
    const stringify = JSON.stringify;
    const parse = JSON.parse;
    const slice = Function.call.bind(String.prototype.slice);
    const freeze = Object.freeze;
    const Text = String;
    const Type = Error;
    const request = async (operation, name, args) => {
      const payload = stringify({ operation, name, args });
      if (payload.length > ${CODE_LIMITS.requestChars}) throw new Type("Tool arguments are too large");
      const reply = parse(await rpc(payload));
      if (reply.error !== undefined) throw new Type(reply.error);
      return reply.value;
    };
    const print = (...values) => {
      let line = "";
      for (const value of values) {
        if (line) line += " ";
        try { line += slice(typeof value === "string" ? value : (stringify(value) ?? Text(value)), 0, ${CODE_LIMITS.logChars} + 1); }
        catch { line += "[unserializable]"; }
        if (line.length > ${CODE_LIMITS.logChars}) break;
      }
      log(slice(line, 0, ${CODE_LIMITS.logChars}), line.length > ${CODE_LIMITS.logChars});
    };
    return {
      tools: freeze({
        search: (query = "", options = {}) => request("search", query, options),
        describe: name => request("describe", name),
        call: (name, args = {}) => request("call", name, args),
      }),
      console: freeze({ log: print, info: print, warn: print, error: print, debug: print }),
      errorMessage: error => slice(typeof error === "string" ? error : Text(error?.message ?? ""), 0, 512),
      encode: value => {
        const json = stringify(value === undefined ? null : value);
        if (json === undefined) throw new Type("Return a JSON value");
        if (json.length > ${CODE_LIMITS.resultChars}) {
          return '{"result":null,"truncated":true}';
        }
        return '{"result":' + json + ',"truncated":false}';
      },
    };
  })
`;

function unwrapEvaluation(result: VmCallResult<QuickJSHandle>, message: string): QuickJSHandle {
  if (result.error) {
    result.error.dispose();
    throw new Error(message);
  }
  return result.value;
}

function readErrorMessage(context: QuickJSContext, result: VmCallResult<QuickJSHandle>): string {
  if (result.error) {
    result.error.dispose();
    return "Script rejected";
  }
  using message = result.value;
  return context.getString(message) || "Script rejected";
}

export async function executeCode(
  code: string,
  deadline: number,
  request: (payload: string) => Promise<string>,
  wasm?: ArrayBuffer,
): Promise<CodeOutput> {
  const wasmBinary =
    wasm ??
    (await Bun.file(
      isAbsolute(wasmPath) ? wasmPath : new URL(wasmPath, import.meta.url),
    ).arrayBuffer());
  const module = await newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmBinary }));
  using runtime = module.newRuntime();
  runtime.setMemoryLimit(CODE_LIMITS.memoryBytes);
  runtime.setMaxStackSize(512 * 1024);
  runtime.setInterruptHandler(() => Date.now() >= deadline);
  using context = runtime.newContext();
  const logs: string[] = [];
  let logsTruncated = false;
  const pending = new Set<QuickJSDeferredPromise>();
  let wake: (() => void) | undefined;
  let deliveryFailed = false;
  let requests = 0;
  using rpc = context.newFunction("rpc", (value) => {
    if (++requests > CODE_LIMITS.requests + 1) return context.undefined;
    const deferred = context.newPromise();
    pending.add(deferred);
    void request(context.getString(value)).then((reply) => {
      if (!pending.delete(deferred)) return;
      try {
        using response = context.newString(reply);
        deferred.resolve(response);
      } catch {
        deliveryFailed = true;
      } finally {
        deferred.dispose();
        wake?.();
      }
    });
    return deferred.handle;
  });
  using log = context.newFunction("log", (value, truncated) => {
    if (logs.length < CODE_LIMITS.logLines) logs.push(context.getString(value));
    else logsTruncated = true;
    if (context.eq(truncated, context.true)) logsTruncated = true;
  });
  using setup = context.unwrapResult(context.evalCode(bootstrap));
  using bindings = context.unwrapResult(context.callFunction(setup, context.undefined, rpc, log));
  using guestTools = context.getProp(bindings, "tools");
  using guestConsole = context.getProp(bindings, "console");
  using encode = context.getProp(bindings, "encode");
  using errorMessage = context.getProp(bindings, "errorMessage");

  try {
    using run = unwrapEvaluation(
      context.evalCode(
        `(async (tools, console) => { "use strict";\n${code}\n})`,
        "tool_execute.js",
      ),
      "Invalid JavaScript function body",
    );
    using promise = unwrapEvaluation(
      context.callFunction(run, context.undefined, guestTools, guestConsole),
      "Script could not start",
    );
    while (Date.now() < deadline) {
      if (deliveryFailed) throw new Error("Could not deliver a tool result within sandbox limits");
      const pumped = runtime.executePendingJobs(32);
      if (pumped.error) {
        pumped.error.dispose();
        throw new Error("Script could not complete its pending JavaScript jobs");
      }
      const state = context.getPromiseState(promise);
      if (state.type === "fulfilled" && !state.notAPromise) {
        using value = state.value;
        using encoded = unwrapEvaluation(
          context.callFunction(encode, context.undefined, value),
          "Script must return a JSON-serializable value within sandbox limits",
        );
        const json = context.getString(encoded);
        if (!hasBoundedJsonShape(json)) return { result: null, logs, truncated: true };
        const result = JSON.parse(json) as Omit<CodeOutput, "logs">;
        return { ...result, logs, truncated: result.truncated || logsTruncated };
      }
      if (state.type === "rejected") {
        using error = state.error;
        throw new Error(
          readErrorMessage(context, context.callFunction(errorMessage, context.undefined, error)),
        );
      }
      if (state.type === "fulfilled") throw new Error("Expected an async JavaScript function");
      if (pumped.value > 0) continue;
      if (pending.size === 0) throw new Error("Script is waiting on an unresolved promise");
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = undefined;
    }
    throw new Error("Code execution timed out");
  } finally {
    for (const deferred of pending) deferred.dispose();
    pending.clear();
  }
}
