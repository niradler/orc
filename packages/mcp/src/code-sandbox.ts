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
    const hasOwn = Object.prototype.hasOwnProperty;
    const isArray = Array.isArray;
    const Text = String;
    const Type = Error;
    const request = async (operation, name, args, connection) => {
      const payload = stringify({ operation, name, args, connection });
      if (payload.length > ${CODE_LIMITS.requestChars}) throw new Type("Tool arguments are too large");
      const reply = parse(await rpc(payload));
      if (reply.error !== undefined) throw new Type(reply.error);
      return reply.value;
    };
    const callError = (code, message) => ({ ok: false, error: { code, message: slice(Text(message), 0, 512) } });
    const callTool = async (name, args = {}, options = {}) => {
      if (typeof name !== "string" || !name.trim()) {
        return callError("INVALID_ARGS", "Tool name must be a non-empty string");
      }
      const input = args === undefined ? {} : args;
      if (input === null || typeof input !== "object" || isArray(input)) {
        return callError("INVALID_ARGS", "Tool arguments must be an object");
      }
      const opts = options == null ? {} : options;
      if (typeof opts !== "object" || isArray(opts)) {
        return callError("INVALID_ARGS", "Tool options must be an object");
      }
      if (opts.timeout_ms !== undefined && (typeof opts.timeout_ms !== "number" || !Number.isFinite(opts.timeout_ms) || opts.timeout_ms <= 0)) {
        return callError("INVALID_ARGS", "timeout_ms must be a positive number");
      }
      let payload;
      try {
        payload = stringify({
          operation: "call",
          name,
          args: input,
          ...(opts.connection !== undefined ? { connection: opts.connection } : {}),
          ...(opts.timeout_ms !== undefined ? { timeout_ms: opts.timeout_ms } : {}),
        });
      } catch {
        return callError("INVALID_ARGS", "Tool arguments must be JSON-serializable");
      }
      if (payload.length > ${CODE_LIMITS.requestChars}) {
        return callError("LIMIT_EXCEEDED", "Tool arguments are too large");
      }
      const reply = parse(await rpc(payload));
      if (reply.ok === false) {
        return callError(reply.error?.code ?? "TOOL_ERROR", reply.error?.message ?? "Tool failed");
      }
      if (reply.ok === true) {
        if (reply.parseJson) {
          return { ok: true, data: parse(reply.text), text: reply.text };
        }
        if ("data" in reply) {
          return { ok: true, data: reply.data, text: reply.text ?? "" };
        }
        return { ok: true, data: reply.text, text: reply.text };
      }
      if (reply.error !== undefined) {
        return callError("TOOL_ERROR", reply.error);
      }
      const value = reply.value;
      const text = typeof value === "string" ? value : (stringify(value) ?? "");
      return { ok: true, data: value, text };
    };
    const settleEntry = async (entry, defaults) => {
      if (entry && typeof entry === "object" && typeof entry.then === "function") {
        try {
          const resolved = await entry;
          if (resolved && typeof resolved === "object" && typeof resolved.ok === "boolean") {
            return resolved;
          }
          const text = typeof resolved === "string" ? resolved : (stringify(resolved) ?? "");
          return { ok: true, data: resolved, text };
        } catch (err) {
          return callError("TOOL_ERROR", typeof err === "string" ? err : Text(err?.message ?? "Tool failed"));
        }
      }
      if (isArray(entry)) {
        const merged = { ...defaults, ...(entry[2] ?? {}) };
        return callTool(entry[0], entry[1] ?? {}, merged);
      }
      if (entry && typeof entry === "object") {
        const merged = {
          ...defaults,
          ...(entry.options ?? {}),
          ...(entry.connection !== undefined ? { connection: entry.connection } : {}),
          ...(entry.timeout_ms !== undefined ? { timeout_ms: entry.timeout_ms } : {}),
        };
        return callTool(entry.name, entry.args ?? {}, merged);
      }
      return callError("INVALID_ARGS", "Each tools.allSettled entry must be a call descriptor or promise");
    };
    const pickOne = (obj, keys) => {
      if (obj === null || typeof obj !== "object" || isArray(obj)) return obj;
      const out = {};
      for (const key of keys) {
        if (typeof key !== "string" || key === "__proto__" || key === "constructor" || key === "prototype") continue;
        if (hasOwn.call(obj, key)) out[key] = obj[key];
      }
      return out;
    };
    const pick = (value, keys) => {
      if (!isArray(keys)) throw new Type("tools.pick expects an array of keys");
      if (isArray(value)) return value.map((item) => pickOne(item, keys));
      return pickOne(value, keys);
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
        search: (query = "", options = {}) => {
          const opts = options == null ? {} : options;
          return request("search", query == null ? "" : Text(query), opts, opts.connection);
        },
        describe: (name, options = {}) => {
          const opts = options == null ? {} : options;
          return request("describe", name, undefined, opts.connection);
        },
        call: callTool,
        allSettled: (calls, options = {}) => {
          if (!isArray(calls)) throw new Type("tools.allSettled expects an array");
          const defaults = options == null ? {} : options;
          return Promise.all(calls.map((entry) => settleEntry(entry, defaults)));
        },
        pick,
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
