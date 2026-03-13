# Gateway Plan — Multi-Channel Multi-Agent Bridge

## Summary

Rename `packages/bridge` → `packages/gateway` and build a generic multi-channel gateway that connects messaging platforms (Telegram, Slack, extensible to Discord and beyond) to ORC's native capabilities (tasks, jobs, memory, sessions) and to live coding agent sessions.

ORC is **multi-agent native**. The gateway supports Claude Code, Codex, and Cursor as first-class agent backends. Each chat can talk to any backend, switch between them, and maintain independent sessions per agent. Agents can be assigned to tasks — the gateway is the remote control surface for orchestrating multiple coding agents from your phone.

Four routed modes per chat binding: **direct** (ORC-native commands), **job:\<name\>** (feed messages into bridge-msg jobs), **agent:\<backend\>** (interactive coding agent sessions with streaming, permissions, and voice), and **multi** (route messages to a specific agent by prefix while managing multiple concurrent sessions).

Telegram gets the full feature surface: inline keyboards, message-edit streaming, voice STT/TTS, review cards.
Slack is text-first in v1: Socket Mode, thread-based replies, Block Kit buttons, no TTS, best-effort audio transcription only when Slack provides a downloadable audio file.

---

## Adopted Design Decisions

Patterns extracted from cc-connect and Claude-to-IM-skill, applied to ORC's multi-agent architecture.

### 1. TryLock — Reject, Don't Queue

When a user sends a message while the agent is processing, **reject immediately** with "still processing" instead of silently queuing. A blocking queue leads to stale responses arriving minutes late. TryLock gives instant feedback and is critical for mobile use where double-taps are common.

This applies per-session, not per-chat. In multi-agent mode a chat may have sessions for Claude, Codex, and Cursor — each with its own lock. Sending to an idle agent while another is busy should succeed.

### 2. Permission Wait Bypasses Session Lock

The blocker and the resolver run on separate paths:
- Agent emits `permission_request` → the event processing loop blocks on a Promise (session lock stays held, no new prompts can be sent).
- User taps Allow/Deny in chat → incoming message handler checks pending permissions **before** the session lock, so the response flows in without being rejected as "busy."

This is the key HITL synchronization pattern. Without it, the user's approval would be rejected by the same lock that's waiting for their approval — a deadlock.

### 3. Promise-Based Permission Gateway

`PermissionManager.waitFor(id)` creates a Promise and stores `{resolve, timer}`. The SDK callback `await`s human response without polling. Three resolution paths:
- User taps button → `resolve(id, approved)` fulfills the Promise.
- 5-minute timeout → auto-deny.
- Daemon shutdown → `denyAll()` resolves all pending as denied — no orphaned Promises.

`resolve()` returns `boolean` (false if ID unknown — idempotent against double-clicks).

### 4. Capability Interfaces — Small Base, Optional Extensions

The base `GatewayAdapter` interface is minimal: `start`, `stop`, `send`. Everything else — message edits, inline buttons, voice, typing indicators, command registration — is an optional interface checked at call sites. Platforms implement only what they support. The router never calls a method that doesn't exist.

This matters because platforms differ radically: Telegram has inline keyboards + voice + message edits. Slack has threads + Block Kit but different voice semantics. Discord has reactions + voice channels. A fat interface forces no-op stubs everywhere.

### 5. Self-Registering Adapter/Backend Registry

Adapters and agent backends register themselves via factory functions at module load. The manager iterates config keys, calls the registry, and starts whatever is enabled. Adding a new platform or agent backend means:
1. Create the implementation file with a `registerAdapter()`/`registerBackend()` call.
2. Add config schema.
3. Import it.

Zero changes to manager, router, commands, store. This is what makes "add Discord" a ~150 line task.

### 6. Streaming Preview with Throttle + Freeze + Degrade

Throttled message edits: min interval (1500ms), min delta (30 chars), max preview length (3000 chars). Three critical behaviors:
- **Freeze** on permission interruptions — stops updating while the user is being asked to approve/deny, preventing confusing interleaved output.
- **Degrade** when edits fail (rate limit, API error) — marks preview as degraded and falls back to a single final message.
- **Dedup** — skip the final edit if text is identical to the last update.

Only active on adapters implementing `CanUpdateMessages`. Platforms without edit support get final-message-only delivery.

### 7. Voice Re-dispatch Through the Same Handler

Voice messages follow a transform-then-re-dispatch pattern: transcribe audio → mutate the message (`text = transcript, fromVoice = true`) → feed it back through the same routing chain. This means voice automatically gets command parsing, mode routing, session locking, rate limiting — zero duplication. The `fromVoice` flag propagates so TTS can be applied to the response.

### 8. StreamState — Classify Subprocess Exit Noise

Agent CLIs (Claude, Codex) often exit with code 1 after delivering a complete response. Track three signals: `hasReceivedResult`, `hasStreamedText`, `lastAssistantText`. The error handler classifies:
- Result already received + exit code → suppress (transport teardown noise).
- Output matches auth error pattern → surface as business error.
- Everything else → real error with full diagnostic.

Without this, every successful agent turn would end with a spurious error message.

### 9. Dead Process Auto-Restart

If `session.alive()` returns false during `send()`, the gateway cleans up state, notifies the user "restarting session", creates a fresh session, and retries — all in one code path. `close()` uses an 8-second graceful timeout before escalating to kill. ORC extends this to multi-agent: a dead Claude session doesn't affect a running Codex session on the same chat.

### 10. Two-Layer Message Dedup

Message ID dedup (60-second TTL window) + process start-time guard (reject messages timestamped before daemon started). The start-time guard is critical for Telegram — on restart, Telegram replays all unacknowledged messages from downtime. Without it, restarting would re-process every message from the last hour.

### 11. Idle Timer Pauses During Permission Waits

A watchdog kills hung agent sessions after a timeout. But the timer **pauses** when the agent is waiting for human permission approval and **resumes** after resolution. Without this, the watchdog would kill the session while the user is reading a tool description and deciding whether to approve.

### 12. Fail-Closed Security

Empty `authorized_users` means deny-all, not allow-all. Privileged operations (agent mode, job triggers) require explicit opt-in. A startup warning fires if authorization isn't configured. Config files containing tokens are written with `0o600` permissions.

### 13. Subprocess Environment Isolation

Agent backends get a filtered environment. Strip `CLAUDECODE` vars (prevents nested session detection). In strict mode, only pass a whitelist of system vars + runtime-specific credentials. Prevents Claude API keys from leaking into Codex processes and vice versa. `SSH_AUTH_SOCK` is forwarded so git operations work.

### 14. Lazy Import for Optional Dependencies

Agent backend SDKs are imported lazily at first use. Users who only run Claude never import `@openai/codex-sdk`. Platform adapters follow the same pattern — don't import Grammy when only Slack is enabled. Clear error messages tell the user what to install.

### 15. Normalized Event Protocol Across Backends

All agent backends emit the same event types: `text`, `thinking`, `tool_use`, `tool_result`, `permission_request`, `result`, `error`. The router and streaming preview consume a single protocol regardless of which agent is active. Adding a new backend (Cursor, Gemini) only requires mapping its events — no changes to the gateway core.

---

## ORC Context

### Multi-Agent Native

ORC is fundamentally multi-agent. The example projects (cc-connect, Claude-to-IM-skill) support switching between backends but treat them as interchangeable — one active agent per chat, swap via config or command. ORC goes further:

- **Multiple concurrent sessions** — a chat can have a Claude session, a Codex session, and a Cursor session alive simultaneously. Each has its own session lock, working directory, and state.
- **Agent-to-task assignment** — tasks in ORC carry an agent field. When a task is assigned to `codex`, the gateway can route task-related messages to the Codex session automatically. Review notifications go back to the same chat where the task was created.
- **Session-per-agent, not session-per-chat** — `gateway_sessions` tracks which backend owns each session. Switching agents doesn't destroy the previous session — it stays idle and can be resumed.
- **Cross-agent orchestration from chat** — a user can `/assign <task-id> codex`, then `/agent claude` to work on something else, then check `/tasks` to see both agents' progress. The gateway is the remote control surface for multi-agent workflows.

This means the gateway must handle:
- Per-session locks (not per-chat), so a busy Claude session doesn't block a Codex message.
- Agent-aware routing — `/agent claude` switches the active backend, `/assign` binds agents to tasks.
- Session isolation — environment, working directory, and permission scope are per-session, not global.

### What ORC Already Has

- **Tasks** with full HITL review flow: `todo → doing → review → done/changes_requested`. Tasks can carry an agent assignment.
- **Jobs** with bridge-msg trigger type — chat messages map to job input via `$MSG` env var.
- **Memories** with FTS5-indexed search (BM25, trigram, LIKE fallback).
- **Session logging** with events, snapshots, and restore.
- **DB schema** with `bridge_chats`, `bridge_messages`, `bridge_permissions`, `gateway_sessions` tables already defined in Drizzle.
- **Config** already refactored: `gateway.telegram`, `gateway.slack`, `speech`, `tts` sections exist.
- **Working gateway code**: `manager.ts` (lifecycle + dispatch), `telegram.ts` + `slack.ts` (adapters), `direct.ts` (command handlers), `backends.ts` (Claude/Codex shell runtimes), `speech.ts` (STT/TTS), `store.ts` (DB layer), `transport.ts` (outbound sends + review notifications).
- **Daemon command** (`orc daemon start/stop/status`) running API + scheduler + watchers.

### What Needs to Change

| Area | Current State | Target State |
|---|---|---|
| Session locking | Promise chain queue (`runExclusive`) — queues silently | TryLock per session — reject with "busy" feedback |
| Permissions | DB update only (`resolvePermission`) — can't wake waiting agent | Promise-based gateway — `waitFor`/`resolve`/`denyAll` |
| Agent backends | Fire-and-forget shell spawn (`claude --print`) — no streaming, no permissions | Persistent subprocess with stdin/stdout streaming + permission protocol |
| Streaming | Single preview message + one final update | Throttled preview manager with freeze/degrade/dedup |
| Adapter pattern | Flat interface — `update()` required on all adapters | Capability interfaces — `CanUpdateMessages`, `CanSendButtons`, etc. |
| Adapter registration | Hardcoded if/else in `manager.start()` | Self-registering factory registry |
| Transport | Separate `transport.ts` creates standalone Bot instances | Outbound sends go through the same adapter instances |
| Multi-agent | Single active backend per chat | Multiple concurrent sessions, agent-to-task assignment |
| Cursor support | Not implemented | Cursor backend via its CLI |
| Error classification | Raw subprocess exit codes surfaced | StreamState-based classification (suppress transport noise) |
| Dedup | None | Two-layer: message ID TTL + start-time guard |
| Config security | No file permission restrictions | `0o600` on config files containing tokens |

### How ORC Differs From the Examples

The example projects are chat-to-agent proxies — they forward messages to an agent and stream back results. ORC owns the workflow state model:

- **Direct mode is first-class** — tasks, jobs, memory, reviews work without an LLM, using ORC's own data model.
- **Review cards use the same state machine** as CLI/MCP/API — the gateway is not a special case.
- **Jobs integrate natively** — `job:<name>` mode maps user messages to job input, retaining chat metadata in `bridge_messages`.
- **Session events are ORC-native** — gateway activity feeds into ORC's session logging/snapshot system.
- **Multi-agent is the default** — the example projects pick one agent. ORC orchestrates many, with task assignment and concurrent sessions.
- **Channel interactions must not bypass ORC's data model** with ad-hoc state.

---

## Architecture

### Layers

```
┌─────────────────────────────────────────────────┐
│  Channel Adapters (Telegram, Slack, ...)         │
│  thin: receive/send + optional capabilities     │
├─────────────────────────────────────────────────┤
│  Gateway Core                                    │
│  ├── Adapter Registry (self-registering)        │
│  ├── Router (direct | job:* | agent:* | multi)  │
│  ├── Command Parser + Shared Handlers           │
│  ├── Streaming Preview Manager                  │
│  ├── Permission Manager (Promise-based)         │
│  ├── Session Lock Manager (TryLock per session) │
│  └── Voice Pipeline (STT/TTS)                   │
├─────────────────────────────────────────────────┤
│  Gateway Store (bridge_* + gateway_sessions)     │
├─────────────────────────────────────────────────┤
│  Agent Runtime (packages/agent-runtime)          │
│  ├── Backend Registry (self-registering)        │
│  ├── Backend Interface                          │
│  ├── Claude Backend (CLI, stream-json stdio)    │
│  ├── Codex Backend (SDK, streamed threads)      │
│  └── Cursor Backend (CLI, background agent)     │
├─────────────────────────────────────────────────┤
│  ORC Core (API, DB, tasks, jobs, memory)         │
└─────────────────────────────────────────────────┘
```

### Adapter Interface (Capability Pattern)

Adopt cc-connect's capability interface pattern. Minimal base, optional extensions:

```typescript
interface GatewayAdapter {
  readonly platform: GatewayPlatform
  start(handler: InboundHandler): Promise<void>
  stop(): Promise<void>
  send(chatId: string, text: string, opts?: SendOpts): Promise<string>
}

interface SupportsMessageUpdate {
  updateMessage(chatId: string, msgId: string, text: string): Promise<void>
}

interface SupportsInlineButtons {
  sendWithButtons(chatId: string, text: string, buttons: Button[][]): Promise<string>
  onButtonCallback(handler: ButtonHandler): void
}

interface SupportsVoice {
  downloadAudio(fileRef: string): Promise<Buffer>
  sendAudio(chatId: string, audio: Buffer, opts?: AudioOpts): Promise<string>
}

interface SupportsTyping {
  showTyping(chatId: string): Promise<void>
}

interface SupportsThreads {
  replyInThread(chatId: string, threadId: string, text: string): Promise<string>
}

interface SupportsCommandRegistration {
  registerCommands(commands: BotCommand[]): Promise<void>
}
```

Check capabilities at call sites:

```typescript
if ('updateMessage' in adapter) {
  await adapter.updateMessage(chatId, msgId, text)
}
```

### Routing Modes

| Mode | Behavior |
|---|---|
| `direct` | ORC-native: task list/get/update/review, memory search, job run/status, system status, mode/cwd changes. No LLM. |
| `job:<name>` | Feed incoming message text into the named job as `$MSG` env var via bridge-msg trigger. |
| `agent:claude` | Forward to Claude Code backend, stream back text/thinking/tool progress/permissions. |
| `agent:codex` | Forward to Codex backend, same normalized event protocol. |
| `agent:cursor` | Forward to Cursor backend via its CLI/agent mode. |
| `multi` | Multiple agents active. Messages route to the active agent, switchable via `/agent <name>`. All sessions stay alive. |

In `multi` mode, `/agent claude` doesn't kill the Codex session — it switches which backend receives the next message. The user can check all agents' status with `/sessions` and resume any of them.

### Per-Chat Binding (stored in `bridge_chats`)

| Field | Purpose |
|---|---|
| `platform` | telegram / slack |
| `chat_id` | Platform-specific chat identifier |
| `mode` | Current routing mode |
| `session_id` | FK to `gateway_sessions` for agent modes |
| `working_dir` | Manually chosen via `/cwd`, persisted |
| `authorized` | Allowlist check result |
| `thread_id` | Platform thread context (Slack threads, Telegram topics) |

### Chat Commands (unified across platforms)

| Command | Mode | Action |
|---|---|---|
| `/help` | any | List available commands for current mode |
| `/status` | any | System status, active sessions per agent, gateway health |
| `/mode [direct\|agent:*\|multi\|job:<name>]` | any | Switch routing mode |
| `/cwd <path>` | any | Set working directory for active session |
| `/tasks` | any | List active tasks (compact, shows agent assignment) |
| `/task <id>` | any | Show full task details |
| `/approve <id> [note]` | any | Approve task review or tool permission |
| `/reject <id> <note>` | any | Reject task review with feedback or deny permission |
| `/assign <task-id> <agent>` | any | Assign a task to an agent (claude/codex/cursor) |
| `/jobs` | any | List jobs with last run status |
| `/run <name>` | any | Trigger a job by name |
| `/mem <query>` | any | Search memories |
| `/sessions` | agent/multi | List all sessions across all backends |
| `/session new\|list\|switch\|stop` | agent/multi | Session lifecycle for current backend |
| `/agent claude\|codex\|cursor` | agent/multi | Switch active agent backend |

---

## Agent Runtime (`packages/agent-runtime`)

New workspace package for persistent interactive agent backends. Self-registering backend pattern — same design as the adapter registry.

### Backend Interface

```typescript
interface AgentBackend {
  readonly name: string
  startSession(opts: SessionOpts): Promise<AgentSession>
  resumeSession(runtimeSessionId: string, opts: SessionOpts): Promise<AgentSession>
  listSessions(): Promise<SessionInfo[]>
  stop(): Promise<void>
}

interface AgentSession {
  readonly id: string
  send(prompt: string, images?: ImageAttachment[]): Promise<void>
  respondPermission(requestId: string, result: PermissionResult): void
  events(): AsyncIterable<AgentEvent>
  alive(): boolean
  close(): Promise<void>
}

type AgentEvent =
  | { type: 'text'; data: string }
  | { type: 'thinking'; data: string }
  | { type: 'tool_use'; data: { id: string; name: string; input: string } }
  | { type: 'tool_result'; data: { toolUseId: string; content: string; isError: boolean } }
  | { type: 'permission_request'; data: { requestId: string; tool: string; command: string } }
  | { type: 'result'; data: { sessionId: string; usage?: unknown } }
  | { type: 'error'; data: string }
```

All backends emit the same `AgentEvent` protocol. The gateway core never knows which agent is running — it consumes events identically.

### Claude Backend

- Spawn `claude` CLI with `--input-format stream-json --permission-prompt-tool stdio --output-format stream-json`.
- Write JSON messages to stdin, read NDJSON events from stdout.
- Map events to unified `AgentEvent` types.
- Permission requests: `control_request` → emit `permission_request` event → block until `respondPermission()` called → write `control_response` to stdin.
- Session resume via `--resume <sessionID>` — the process stays alive across turns, preserving context.
- Track `alive()` via process exit detection. Auto-restart on death with user notification.
- `close()` uses 8-second graceful timeout before escalating to kill.
- stderr captured in a ring buffer for diagnostics.
- StreamState tracking: classify exit codes — suppress transport noise, surface auth errors, report real failures.
- Environment isolation: strip `CLAUDECODE` vars, pass `ANTHROPIC_API_KEY` only.
- CLI resolution: gather all candidates from PATH + well-known locations, pick first compatible (>= 2.x with stream-json support), preflight check at startup.

### Codex Backend

- Use `@openai/codex-sdk` (lazy import — optional dependency, `Function('return import(...)')()` to bypass bundler).
- Map Codex thread events (`thread.started`, `item.completed`, `turn.completed`) to the same `AgentEvent` protocol.
- Session resume via stored thread IDs. Retry with fresh thread if resume fails (model mismatch, unknown session).
- Map permission modes to Codex approval policies (`acceptEdits` → `on-failure`, others → `on-request`).
- Environment isolation: pass `OPENAI_API_KEY` only, strip Claude-specific vars.

### Cursor Backend

- Spawn Cursor's CLI agent mode (background agent).
- Map output to `AgentEvent` protocol — Cursor emits structured events for file edits, terminal commands, and tool calls.
- Permission handling maps to Cursor's approval model.
- Session persistence via Cursor's own session management (composer IDs).
- The gateway doesn't replace Cursor's IDE — it provides a remote chat interface to Cursor's agent capabilities.

### Session Locking

One active turn per session. TryLock per session, not per chat:

```typescript
class SessionLock {
  tryAcquire(sessionId: string): boolean
  release(sessionId: string): void
  isLocked(sessionId: string): boolean
}
```

In multi-agent mode, a chat may have Claude, Codex, and Cursor sessions. Locking is per-session — sending to idle Codex while Claude is busy succeeds. Overlapping messages to the same session get "still processing" feedback.

### Multi-Agent Session Management

```
Chat (telegram:123456)
├── Session A: claude (idle)     cwd=/projects/api     task:01JX...
├── Session B: codex  (running)  cwd=/projects/web     task:01JY...
└── Session C: cursor (idle)     cwd=/projects/mobile
```

- Each session tracks its own: backend, cwd, status, runtime session ID, lock state, last error, assigned task.
- `/agent claude` makes Session A the active target for messages. Session B keeps running.
- `/assign 01JX claude` binds a task to the Claude session. When that task enters `review`, the notification goes to this chat.
- `/sessions` shows all sessions with their backend, status, cwd, and assigned task.
- Session isolation: a failed Codex session doesn't affect Claude or Cursor.

---

## Streaming Preview

Adopt cc-connect's throttled preview pattern:

| Parameter | Default | Purpose |
|---|---|---|
| `minInterval` | 1500ms | Minimum time between message edits |
| `minDelta` | 30 chars | Minimum new content before triggering an edit |
| `maxLength` | 3000 chars | Truncate preview beyond this |

- Only active on adapters implementing `SupportsMessageUpdate`.
- On platforms without edit support (or when edits fail), degrade to final-message-only delivery.
- Freeze preview during permission interruptions.
- Dedup: skip edit if text unchanged since last update.

---

## Permission & Review Flow

### Tool Permissions (agent mode)

The permission flow uses the Promise-based gateway pattern (decision #3) with session lock bypass (decision #2):

1. Agent emits `permission_request` event with `requestId`, `tool`, `command`.
2. `PermissionManager.waitFor(requestId)` creates a Promise and stores `{resolve, timer}`. The event processing loop awaits this Promise — the session lock stays held (no new prompts), but the streaming preview freezes (decision #6).
3. Gateway stores permission record in `bridge_permissions` (status=pending, expires_at=now+5min).
4. Adapter sends inline-button message: `[Allow] [Deny] [Allow for session]`.
5. User taps button → incoming message handler checks pending permissions **before** session lock → `PermissionManager.resolve(requestId, result)` fulfills the Promise. The resolve path bypasses TryLock so it can't be rejected as "busy."
6. "Allow for session" sets `autoApprove = true` on the gateway session → future permission requests auto-approved for this session's lifetime.
7. Timeout (5 min) → auto-deny, update `bridge_permissions` status=expired, resume streaming preview.
8. On daemon shutdown → `PermissionManager.denyAll()` resolves all pending Promises as denied — no orphaned waits, no process hang.

In multi-agent mode, each session has its own pending permissions. Approving a Claude permission doesn't affect Codex permissions.

### Task Review (direct mode and proactive notifications)

- Task review cards sent via inline-button mechanism to all authorized chats.
- Review cards show the task title, agent assignment, and summary.
- Approval calls the same `approveTask()` that CLI/MCP/API use — `status=done`.
- Rejection calls `rejectTask()` — `status=changes_requested` with the rejection note.
- Same state machine everywhere — the gateway is not a special case.
- When a task has an assigned agent and transitions to `changes_requested`, the gateway can optionally notify the agent's session to pick up the feedback.

---

## Voice Pipeline

### STT (Speech-to-Text)

1. Adapter receives voice/audio message → calls `downloadAudio()`.
2. Check format — if not MP3/WAV, run ffmpeg normalization (OGG/AMR → MP3).
3. If ffmpeg unavailable, log warning and send "voice not supported without ffmpeg" reply.
4. Send to configured STT provider (OpenAI Whisper / Groq / Qwen ASR).
5. Transcribed text re-dispatched through normal message handler with `fromVoice = true`.

### TTS (Text-to-Speech)

1. Agent produces final text reply.
2. If TTS enabled and mode matches (`always` or `voice_only` when `fromVoice`):
   - Text → TTS API (Qwen / OpenAI) → audio buffer.
   - Send via `adapter.sendAudio()` alongside text reply.
3. Skip TTS for Slack in v1.

---

## DB Schema Changes

### Keep existing `bridge_*` tables (additive evolution)

No destructive renames. The `bridge_chats`, `bridge_messages`, `bridge_permissions` tables stay as-is with the fields already added (`session_id`, `thread_id`, `working_dir`, `platform_msg_id`, `metadata`, `scope`, `expires_at`, `gateway_session_id`).

### `gateway_sessions` table (already defined, extend for multi-agent)

| Column | Type | Purpose |
|---|---|---|
| `id` | text PK | ULID |
| `chat_id` | text FK | → bridge_chats.id, cascade delete |
| `backend` | text | claude / codex / cursor |
| `mode` | text | agent:claude / agent:codex / agent:cursor |
| `runtime_session_id` | text | Backend-specific session ID (CLI session, thread ID, composer ID) |
| `cwd` | text | Working directory for this session |
| `title` | text | Session label |
| `model` | text | Model override if set |
| `status` | text | idle / running / stopped / error |
| `auto_approve` | integer | 1 if "allow for session" was granted — auto-approve future permissions |
| `task_id` | text FK | Assigned task ID (nullable) — links session to a task for routing |
| `last_error` | text | Last error message |
| `last_activity_at` | integer | Epoch ms |
| `created_at` / `updated_at` | integer | Timestamps |

Multiple sessions per chat are expected. The `bridge_chats.session_id` FK points to the **active** session (the one that receives the next message). Other sessions stay alive in idle/stopped state.

---

## Daemon Integration

`orc daemon start` must start gateway adapters alongside API + scheduler + watchers.

### Isolation

- Each adapter starts independently. A broken Telegram token must not prevent Slack from starting.
- Wrap each adapter start in try/catch, log errors, continue with healthy adapters.
- `orc daemon status` should surface: which adapters are connected, last activity, error state.

### Startup Sequence

```
1. Start API server
2. Start job scheduler + file watchers
3. For each configured gateway adapter:
   a. Validate config (token present, etc.)
   b. Create adapter instance
   c. Start adapter with gateway core as handler
   d. Register bot commands if adapter supports it
   e. Log success or error, continue either way
```

### Shutdown

```
1. Stop all gateway adapters (deny pending permissions, close agent sessions)
2. Stop scheduler
3. Stop API server
```

---

## CLI Extensions

### `orc gateway status`

Show gateway health: connected adapters, active sessions, pending permissions, last errors.

### `orc gateway send`

Manual outbound message: `orc gateway send --platform telegram --chat <id> --text "deploy complete"`.
Useful for scripts and cron jobs that need to notify operators.

---

## Security

- **Allowlists**: per-platform `authorized_users` list in config. Default-deny — unknown users get "not authorized" response.
- **Secret redaction**: strip bot tokens and API keys from all log output (regex mask, show last 4 chars).
- **No inbound webhooks**: Telegram uses long polling, Slack uses Socket Mode. No public HTTP endpoints.
- **Credential isolation**: gateway process inherits daemon env but agent backends should get a filtered env (strip cross-runtime credentials).
- **Permission expiry**: pending permissions auto-expire after 5 minutes. Daemon restart denies all pending.

---

## Reliability

- **Message dedup**: track inbound message IDs with 60-second TTL window. Prevents double-processing on reconnect.
- **Rate limiting**: per-chat sliding window (configurable, default 20 msgs / 60s). Excess messages get a "slow down" reply.
- **Adapter isolation**: one broken adapter doesn't crash the daemon. Health tracked per-adapter.
- **Atomic state writes**: all store mutations use write-to-tmp + rename pattern.
- **Session liveness**: periodic `alive()` check on agent sessions. Dead sessions get cleaned up and user is notified.
- **Startup drain**: Telegram adapter should drain pending updates on startup to avoid re-processing messages from while the daemon was down.
- **Old message filtering**: reject messages with timestamps before daemon start time.

---

## Implementation Order

### Phase 1: Gateway Core Refactor

Refactor existing code to adopt the design decisions. No new features — same functionality, better structure.

1. Adapter registry + capability interfaces — refactor `telegram.ts` and `slack.ts` into `adapters/` with self-registration and capability interfaces (`CanUpdateMessages`, `CanSendButtons`, `CanSendAudio`).
2. Replace `runExclusive` promise chain with TryLock per session — reject with "busy" feedback.
3. Build `PermissionManager` with Promise-based `waitFor`/`resolve`/`denyAll`. Wire permission bypass before session lock check.
4. Build `PreviewManager` with throttle/freeze/degrade/dedup. Wire into agent response flow.
5. Add message dedup (ID TTL + start-time guard) and rate limiting.
6. Kill `transport.ts` — outbound sends go through adapter instances held by manager.
7. Wire gateway startup into `orc daemon start` with adapter isolation (one broken token doesn't crash others).
8. Add `0o600` permissions on config file writes.

### Phase 2: Agent Runtime + Claude Backend

1. Create `packages/agent-runtime` with backend interface and self-registering backend registry.
2. Implement Claude backend — persistent subprocess with `--input-format stream-json --permission-prompt-tool stdio`, stdin/stdout event mapping, session resume, liveness check, auto-restart, StreamState error classification, CLI resolution with preflight check, env isolation.
3. Wire `agent:claude` mode into gateway router with streaming preview + permission handling.
4. Add agent-aware session commands (`/sessions`, `/session new|list|switch|stop`).
5. Test: Claude session round-trip from Telegram with streaming, permissions, auto-restart.

### Phase 3: Multi-Agent + Codex + Cursor

1. Implement Codex backend — lazy SDK import, thread events to `AgentEvent` protocol, session resume with retry, env isolation.
2. Implement Cursor backend — CLI agent mode, event mapping, session persistence.
3. Add `multi` routing mode — multiple concurrent sessions per chat, per-session locks, `/agent` switches active backend without killing others.
4. Add `/assign <task-id> <agent>` command — bind tasks to agent sessions, route review notifications.
5. Add `gateway_sessions.task_id` and `gateway_sessions.auto_approve` columns.
6. Test: Claude + Codex sessions alive simultaneously on same chat. Assign tasks to specific agents. Switch between agents. Dead session doesn't affect others.

### Phase 4: Slack Adapter + Voice Pipeline

1. Refactor `slack.ts` into `adapters/slack.ts` with Socket Mode, DM/mention handling, thread replies, Block Kit buttons, reconnect-on-close.
2. Wire voice re-dispatch pattern — transcribe → mutate message → re-dispatch through same handler with `fromVoice = true`.
3. Wire TTS via adapter capability check (`CanSendAudio`) instead of platform string comparison.
4. Add idle timer with pause during permission waits.
5. Test: Codex from Slack. Voice → Claude on Telegram. Approve task from both platforms.

### Phase 5: Polish + Extensibility

1. `orc gateway status` and `orc gateway send` CLI commands.
2. Review notification cards — proactive push to authorized chats when tasks enter `review`.
3. Startup drain for Telegram (discard updates from before daemon start).
4. Secret redaction in gateway logs (regex mask, last 4 chars).
5. Subprocess env isolation per backend (whitelist only relevant credentials).
6. Integration tests for full multi-agent multi-platform flows.

---

## Test Plan

### Unit Tests

- Mode routing: message → correct handler based on chat mode (direct, job:*, agent:*, multi).
- Command parsing: slash commands with args, unknown command handling.
- TryLock: concurrent sends to same session → "busy" rejection. Concurrent sends to different sessions on same chat → both succeed.
- Permission manager: `waitFor` → `resolve` (approve/deny), timeout auto-deny, `denyAll` on shutdown, double-click idempotency, unknown ID returns false.
- Permission bypass: permission response reaches waiting session despite session lock being held.
- Streaming preview: throttle interval, min delta, max length, freeze on permission, unfreeze after resolution, degrade on edit failure, dedup on identical final text.
- StreamState: suppress exit-code-after-result, surface auth errors, report real failures.
- STT/TTS provider selection and ffmpeg-missing fallback.
- Adapter registry: register → create by name, unknown adapter throws.
- Backend registry: register → create by name, lazy import for optional SDKs.

### Adapter Tests

- Telegram: bot commands, inline keyboard callbacks, voice download, message edit, typing indicator.
- Slack: DM/mention parsing, thread replies, Block Kit button actions, reconnect on socket close.
- Capability check: adapters correctly implement/omit optional interfaces.
- Allowlist enforcement on both platforms. Empty list = deny all.

### Multi-Agent Tests

- Create Claude + Codex sessions on same chat. Both alive simultaneously.
- Send to Claude while Codex is busy → Claude receives, Codex stays locked.
- `/assign <task> codex` → task review notification routes to correct chat.
- `/agent claude` switches active session without killing Codex.
- Dead Claude session → auto-restart → doesn't affect running Codex session.
- `/sessions` lists all sessions with correct backend, status, cwd, assigned task.

### Integration Tests

- `orc daemon start` starts API + scheduler + gateway cleanly. One broken adapter token doesn't prevent others.
- Direct mode: list/update tasks, run jobs, search memory from Telegram.
- Bridge-msg: job triggers from chat messages with correct `$MSG`.
- Task review: approve via inline button → task status=done. Same state machine as CLI/MCP.
- Task review: reject via inline button → task status=changes_requested with note.
- Claude backend: full session round-trip with streaming preview + permission approval + "allow for session" auto-approve.
- Codex backend: full session round-trip with streaming + permission approval.
- Cursor backend: session start, prompt, streamed result.
- Telegram voice: voice message → STT → agent reply → optional TTS reply.
- Cross-platform: same task review flow works from both Telegram and Slack.
- Approve a task review and a tool permission from phone without touching the terminal.
- Daemon shutdown: all pending permissions denied, all agent sessions closed, no process hang.
- Daemon restart: Telegram drains old updates, sessions resume from stored runtime IDs.

---

## Assumptions

- **gateway** is the public name. No compatibility alias for `@orc/bridge`.
- Keep `bridge_*` table names internally — evolve additively, no destructive DB rename.
- Manual per-chat `/cwd` is the source of truth for working directory. Per-session override via `/cwd` when multiple sessions have different working directories.
- Single local ORC daemon per `ORC_HOME`.
- Pending permissions expire on daemon restart (5 min timeout, `denyAll` on shutdown) rather than resuming mid-turn.
- Slack voice is secondary — only transcribe when Slack provides a downloadable audio file.
- Multi-agent is opt-in via `multi` mode. `agent:claude` mode still means single-agent for simplicity.
- Agent backend CLIs (claude, codex, cursor) must be installed and on PATH. The gateway validates at startup with preflight checks, not at first message.
- Cursor backend availability depends on Cursor's CLI agent mode API stability — may lag behind Claude and Codex in feature parity.
