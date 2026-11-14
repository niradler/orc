# @orc/rule-client

Shared agent-side client for ORC rule hooks. One generic adapter factory; each coding
agent supplies only its native event map. All rule evaluation stays in
`orc rules hook <backend> <event>` against the local ORC database, so every agent shares
the same decisions, audit history and fail-closed behavior.

## Why

Pi and OpenCode embed the rule client in their own extension/plugin process. Claude,
Codex, Cursor and Gemini instead spawn the same CLI from installed native hooks. The
client-side work — planning which events to deliver, gating, transporting the hook call
and parsing its decision — is identical for every embedded agent, so it lives here once.

## Usage

```ts
import { createRuleClient } from "@orc/rule-client/factory";

const client = createRuleClient({
  backend: "opencode",
  phases: { "execute.before": "pre_tool", "execute.after": "post_tool" },
  blocking: ["execute.before"],
});

const plan = client.planRules(history, cwd); // which native events carry rules
const gate = client.gate({ enabled: true, plan, disabled: false, native: "execute.before" });
if (gate.run) {
  const decision = await client.runHook({
    command: "orc",
    native: "execute.before",
    payload: { session_id: "s", tool_call_id: "t", cwd, tool_name: "bash", tool_input: input },
    cwd,
    env: {},
    timeoutMs: gate.timeoutMs,
  });
}
```

Prebuilt adapters: `@orc/rule-client/pi` and `@orc/rule-client/opencode` export the native
phase maps, blocking sets and bound `planRules` / `ruleHookGate` / `runRuleHook` functions.

## Modules

| Module       | Contents                                                                             |
| ------------ | ------------------------------------------------------------------------------------ |
| `./factory`  | `createRuleClient(spec)` — the generic adapter factory                               |
| `./types`    | `OrcRule`, `OrcRulePolicy`, `OrcRuleRevision`, `RulePlan`, `HookDecision`, `HookRun` |
| `./hook`     | `runRuleHook`, `parseHookOutput`, timeout constants                                  |
| `./plan`     | `rulesForCwd`, `planRules`, `nativeFor` (canonical and `native:` events)             |
| `./gate`     | `ruleHookGate`, `RULES_REFRESH_MS`                                                   |
| `./policy`   | `upsertRule`, `removeRule` policy-edit helpers                                       |
| `./pi`       | Pi adapter (`tool_call`, `tool_result`, `input`, lifecycle events)                   |
| `./opencode` | OpenCode adapter (`execute.before`, `execute.after`, `prompt`, `compaction`)         |

## Failure behavior

- Blocking events fail closed: spawn failure, timeout, abort or a nonzero hook exit
  denies the call.
- Non-blocking events fail open: observation never stalls the agent.
- Without a loaded plan, blocking events still run the hook; only a confirmed global
  disable skips enforcement. A loaded plan selects exactly its events.

Canonical phases (`pre_tool`, `post_tool`, `prompt_submit`, …) drive rule matching;
`native:<name>` scopes keep host-specific events addressable.
