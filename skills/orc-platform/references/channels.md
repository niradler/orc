# Channels: messages, setup and inbound routing

Channels are bidirectional: an approved inbound message can invoke an agent through an ordered route; an authorized agent can send independently through MCP or HTTP API. Settings > Channels manages connections, recipients and rules. Telegram and Slack are supported; Slack has two providers — `slack` (a Slack app, posts as the bot) and `slack-user` (your own Slack session via earshot, posts as you, for workspaces where an app cannot be installed).

## Discover before sending

1. Select the intended ORC installation and project; call context as usual.
2. Call `channel_list` for connections, readiness, provider capabilities and native API documentation.
3. Call `channel_targets` with a connection ID. Use a configured recipient alias such as `me`; never invent chat IDs or choose a different recipient on failure.
4. Call `channel_send`; retain its receipt ID. Use `channel_message_get` to inspect delivery and `channel_message_update` to edit an accepted message.

All request bodies are JSON. Examples below are MCP arguments; the equivalent send API is `POST /api/channels/messages` with the same body (use `project_id` for HTTP requests).

```json
{
  "connection": "personal-telegram",
  "target": "me",
  "message": {
    "text": "**Task completed**\nTests passed.\n\n- API updated\n- Documentation updated",
    "links": [{ "label": "Open task", "url": "https://orc.example/tasks/123" }]
  },
  "idempotency_key": "task-123-summary-v1"
}
```

Common Markdown is the default: emphasis, lists, code and links render automatically for the provider. Use `message.format: "plain"` for literal text. Long generated messages split safely; check returned warnings for presentation fallback. `thread_id` selects a reply thread within an approved destination; a destination bound to a specific thread cannot be redirected.

## Full native message control

`overrides` is a native provider JSON object. It is not a list of ORC instructions and has no extra provider-name wrapper. Every provider-supported message option, including new fields ORC does not know about, passes through. Explicit values replace generated values; arrays replace entire arrays. The provider validates native options. ORC does not automatically rewrite, split or sanitize explicit native presentation.

Slack, using native Block Kit:

```json
{
  "connection": "work-slack",
  "target": "me",
  "message": { "text": "Task completed. Open the task in ORC." },
  "overrides": {
    "unfurl_links": false,
    "blocks": [
      { "type": "section", "text": { "type": "mrkdwn", "text": "*Task completed*\nAll checks passed." } },
      { "type": "actions", "elements": [
        { "type": "button", "action_id": "open-task", "text": { "type": "plain_text", "text": "Open task" }, "url": "https://orc.example/tasks/123" }
      ] }
    ]
  }
}
```

Telegram, using native HTML and an inline keyboard:

```json
{
  "connection": "personal-telegram",
  "target": "me",
  "message": { "text": "Task completed." },
  "overrides": {
    "text": "<b>Task completed</b>\n<code>12 tests passed</code>",
    "parse_mode": "HTML",
    "disable_notification": true,
    "reply_markup": { "inline_keyboard": [[
      { "text": "Open task", "url": "https://orc.example/tasks/123" }
    ]] }
  }
}
```

Keep fallback text useful for Slack notifications and accessibility. Escape your own native HTML/mrkdwn as the provider requires. Overrides are bounded JSON, not an arbitrary HTTP proxy: ORC controls credentials, provider endpoint, message ownership and authorized destination. `channel_send` uses Telegram `sendMessage` or Slack `chat.postMessage`; overriding message options does not select another API operation. Native attachment/block options are available on those methods; separate file-upload endpoints are not implied.

Connection `config.message_defaults` can set native message defaults. Precedence is generated common message, then connection defaults, then per-send overrides. Credentials never belong in config/message payloads.

Native references: [Telegram sendMessage](https://core.telegram.org/bots/api#sendmessage), [Telegram formatting](https://core.telegram.org/bots/api#formatting-options), [Slack chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/), [Slack Block Kit](https://docs.slack.dev/block-kit/).

## Setup

Telegram: use BotFather to obtain a bot token, enter it directly or reference
`env:ORC_TELEGRAM_TOKEN` in Settings. Save and verify the bot, enable the
connection, then use Pair my Telegram. Open the expiring link, start the bot
and confirm the candidate user/chat in authenticated Settings. This creates
`me` for outbound messaging; inbound and Attention are separate opt-ins. ORC
uses long polling. A webhook or another active poller is an ownership
conflict; do not delete a webhook or steal the bot automatically.

Slack: copy the manifest in Settings, create/install a Slack app in the
intended workspace, enable Socket Mode, and configure the bot token and app
token, entered directly or as `env:ORC_SLACK_BOT_TOKEN` /
`env:ORC_SLACK_APP_TOKEN`. The manifest (`GET /api/channels/slack-manifest`)
requests scopes `commands`, `chat:write`, `im:write`, `im:history`,
`mpim:history`, `channels:history`, `groups:history`, `app_mentions:read`,
`files:read`, `users:read` and events `message.im`, `message.mpim`,
`message.channels`, `message.groups`, `app_mention`; an existing Slack app
must be reinstalled from the current manifest to pick up `mpim:history`,
`files:read` and `users:read`. Verify the workspace. Pair a private DM through
Pair my Slack, or configure an approved channel ID and sender IDs manually
(DMs, group DMs/mpim and channels with an app mention are all supported).
Invite the bot to channel destinations. Permissions and event subscriptions
must cover the selected conversation types; inspect provider errors such as
`missing_scope`, `not_in_channel`, or `channel_not_found`. Slack replies show
live "Working…" progress with a Stop button while an agent turn runs, and
support inbound/outbound file attachments (outbound Slack file reads need
`files:read`).

Slack user session (`slack-user`): no app and no admin approval. Paste the
`xoxc` token (Slack web client DevTools console: `TS.boot_data.api_token`) and
the `d` cookie (DevTools → Application → Cookies), directly or as
`env:ORC_SLACK_USER_TOKEN` / `env:ORC_SLACK_USER_COOKIE`; on macOS
`bunx @niradler55/earshot token` prints both from the desktop app. The cookie
is a full-access session secret — treat it like a password. Verify identity,
then pair by sending the pairing text in a DM to yourself. ORC listens on the
same realtime socket as your web client and posts replies as you. There is no
bot user: messages starting with `@orc` (or mentioning your own user id) are
marked `is_mention` and keep their text for keyword rules; route them with
`session: "thread"` for in-thread agent conversations. No button interactions
(controls render as typeable commands), no file attachments, and messages sent
during a socket reconnect are not replayed. A rejected session surfaces
`session_expired`; paste a fresh token and cookie and save to reconnect.
Connection config accepts `{"transport": "auto" | "rtm" | "gateway"}`. This is
an unofficial transport outside Slack's API terms; prefer the bot provider
where an app is allowed.

Pairing is short-lived, single-use and requires authenticated confirmation. Only one listener owns a provider account. Secrets are server-side encrypted or referenced through environment variables (`env:ORC_TELEGRAM_TOKEN`, `env:ORC_SLACK_BOT_TOKEN`, `env:ORC_SLACK_APP_TOKEN`, `env:ORC_SLACK_USER_TOKEN`, `env:ORC_SLACK_USER_COOKIE`) and are never returned to agents or the browser. Never paste bot credentials into an MCP message, scratchpad or job prompt.

## Ordered inbound routing

Enable inbound on an approved destination and list allowed sender IDs. A
destination's `chat_id` can be `*` (any chat) and/or `user_ids` can include
`*` (any sender), shown in Settings as the "Any chat"/"Any sender" checkboxes.
A sender matched only through a `*` entry gets replies only: no chat controls,
no `/project`/`/agent`/`/model` commands, and approvals/questions never reach
them (they go to ORC Notifications instead) — pair that with
`permissions: "read_only"` and a restricted profile. A `*` chat cannot have
Attention, notifications or a thread, and a `*` sender cannot have Attention.
`POST /api/channels/messages` and `channel_send` refuse `*` chat destinations:
they only carry replies to their senders. Authorization
precedes routing. Rules run in saved order; the first enabled matching rule
wins. No match launches no agent. An ignore rule stops routing. No implicit
fallthrough into a general-purpose agent handler is allowed.

Settings provides a visual builder for nested **Match all (AND)**, **Match any (OR)** and **Exclude matches (NOT)** groups. Conditions use named fields, comparisons and typed values; no JSON editing is needed. Numbered rules show their conditions and destination. Move rules up/down to set priority; disabled rules are skipped. Apply a rule, then save the connection. Preview uses saved rules and never invokes an agent.

The separate **Otherwise** rule is optional, fixed last, and runs only after every enabled condition rule fails. It can route to an agent or ignore silently; recipient/project authorization still applies. With no enabled default, authorized unmatched messages get setup guidance and no agent starts. Reply setup and newly added rules insert before Otherwise. HTTP configuration represents this final fallback with `condition: {"always":true}`; the API rejects multiple defaults, a default before other rules, or a nested `always` predicate.

API condition trees support `all`, `any` and `not`, with at most five levels and 100 condition nodes. Predicates have `field`, `op`, and `value`. Fields: `sender`, `chat`, `thread`, `text`, `command`, `is_direct`, `is_mention`, `is_followup` (the message continues a thread an agent already answered on this connection), `kind`. Operators: `is`, `in`, `contains`, `contains_any` (case-insensitive keyword list), `starts_with`. `in`/`contains_any` use a string array; boolean comparisons use JSON booleans. Comparisons are otherwise case-sensitive. A `{"time": {...}}` condition instead of `field`/`op`/`value` restricts a rule to a window: `days` (0=Sun..6=Sat, omit for every day), `from`, `to` (`HH:MM`, overnight ranges allowed when `from` > `to`), `tz` (IANA zone); wrap it in `not` for "outside hours". No arbitrary scripts or unbounded regular expressions — regex is deliberately unsupported on inbound text.

```json
{
  "id": "private-work",
  "name": "Nir's private work messages",
  "enabled": true,
  "condition": {
    "all": [
      { "field": "is_direct", "op": "is", "value": true },
      { "any": [
        { "field": "command", "op": "is", "value": "work" },
        { "field": "text", "op": "starts_with", "value": "ORC " }
      ] },
      { "not": { "field": "text", "op": "contains", "value": "ignore" } }
    ]
  },
  "action": { "type": "agent", "agent": "codex", "project_id": "PROJECT_ID" }
}
```

An agent action names its backend and project; optional `model` pins a model and `profile` selects an existing agent profile, whose instructions, tool allowlist and model become that rule's persona. `session` picks `continue` (one rolling conversation per chat/thread/sender, the default), `thread` (one session per thread; a top-level Slack message starts a new thread and the reply lands in it, and everyone in the thread shares the session) or `message` (a fresh session every message). `permissions` picks `ask` (approvals come to you), `read_only` (only Read, Grep, Glob, LS, WebFetch and WebSearch; ORC MCP is off; backends that cannot enforce a tool allowlist refuse to run), `accept_edits` or `auto` (no prompts); senders matched only through `*` never get more than `read_only`, never get ORC MCP, and cannot trigger a job whose agent runs with `accept_edits` or `auto`. `options` carries the same per-agent launch options as the chat composer, such as effort; options that approve more than `permissions` (Claude `bypassPermissions` or `acceptEdits`, ACPX `--approve-all` or `--approve-reads`) are rejected. The project needs an active scope directory available on the configured execution host. Agent replies return through the original destination. Pairing and Attention commands are handled before ordinary routing. Native button callbacks have `kind: "action"`; their value (or Slack action ID when no value exists) is untrusted input that can reach an agent only through an authorized matching route. New rules default to `kind: "message"`; use an action rule to handle custom buttons. A rule without a kind condition can match either kind. A callback never directly executes a command or bypasses native permissions.

A `job` action (`{"type": "job", "job_id": "..."}`) runs that job with the message text on stdin and `ORC_CHANNEL_CONNECTION`, `ORC_CHANNEL_PROVIDER`, `ORC_CHANNEL_CHAT`, `ORC_CHANNEL_THREAD`, `ORC_CHANNEL_SENDER`, `ORC_CHANNEL_SENDER_NAME` and `ORC_CHANNEL_ROUTE` in its environment; the job's stdout is the reply, and a nonzero exit reports a status line instead.

Use the saved-rule preview in Settings, or `POST /api/channels/{id}/route-test`, to test authorization and rule matching without invoking an agent.

## Questions, approvals and delivery

Use existing `human_request` / `human_request_get` / `human_request_acknowledge` tools for durable questions and approvals. Select provider notifications with `notify`; the destination must opt into Questions and approvals. Channel-native agent requests enter the same Attention store. `/attention` replies are bound to the offered connection, recipient, chat/thread, request version and expiry. Approval messages do not bypass ORC rules or native permissions.

`accepted` means the provider accepted a message, not that Nir read it. `failed` means a definite provider rejection; `unknown` means the request may have reached the provider; `partial` means some chunks succeeded. Inspect unknown/partial outcomes before retrying. The same idempotency key and identical request return the same receipt; reusing a key with different content conflicts. Never promise exactly-once delivery across network failures.

Receipt/idempotency metadata and inbound duplicate records are retained for 30 days. Expired pairing/action metadata is pruned after a further day. Queued invocations recheck current authorization and routing before execution. Editing a recipient does not redirect an already running agent's reply. A detected competing Telegram poller leaves the connection stopped; resolve the conflict and save explicitly to retry.

HTTP API: provider discovery and `/channels`; `PUT /channels/{id}` for revision-checked configuration; `/channels/{id}/verify`, `/targets`, `/pairings`, `/route-test`; `/channels/pairings/{id}` and `/confirm`; `POST /channels/messages`; `GET`/`PATCH /channels/messages/{id}`. Prefix paths with `/api`. API and MCP use the same service and validation. The SDK exposes `channels` methods. Routine agent MCP does not expose credential/setup writes.

Definitions live in SQLite (`channels`, `channel_targets`, `channel_routes`). Provider configuration and encrypted credential references are JSON fields; rule order is explicit. Preserve the returned `revision` when saving configuration; reload on a conflict rather than overwriting someone else's changes.

## Two-way conversations and chat controls

In Settings → Connections → Channels, pair a recipient, then choose **Set up agent replies**. Select its default project, agent and optional model, apply, then save. Agent `default` follows Chat Settings. The flow enables inbound/outbound/questions and retains recipient project restrictions. Earlier routing rules retain priority. Every selected project needs an active working folder available on the execution host.

The first matching rule supplies defaults. Ordinary messages reach the selected agent; follow-ups resume its native session. Conversations are separated by connection, chat, thread, sender and route. Sessions and model choices are additionally separated by project. Unmatched messages explain setup; explicit ignore rules remain silent. Unapproved senders invoke neither controls nor agents.

The intentionally small control menu manages chat:

- `/help`: chat controls and custom shortcuts.
- `/status`: active project/folder, agent, model and session.
- `/project [name-or-id|default]`: choose an allowed project with buttons or by name. The project's configured working folder is the agent spawn directory. Returning to a project resumes its selected conversation. Recipient project restrictions are enforced on selection and every subsequent turn.
- `/agent [name|default]`: choose an agent with buttons or restore the routing default. Conversations for different agents remain separate and can be selected again.
- `/model [id|default]`: choose from the available model catalog or supply an explicit ID. Restore the route/backend default with `default`; the choice takes effect on the next turn and persists with that session.
- `/session new|list|switch <id-or-number>|stop`: create, select or stop sessions in the active project. Switch controls restore that session's agent/model. `/stop` immediately cancels the active turn and already queued input.

Tasks, jobs and other ORC operations belong to the agent's tools. Unknown slash input goes to the backend's native command vocabulary. Sensitive operations still use existing human approvals.

Slack uses the app's `/orc` entry point: `/orc help`, `/orc project my-project`, `/orc session new`, `/orc summary task-123`. The Slack manifest registers `/orc` with the `commands` scope. Plain messages and mentions use the same routing pipeline. The `slack-user` provider has no app entry point; type `@orc <message>` (or any routed keyword) instead. Telegram registers the chat controls and configured shortcuts in its command menu.

Configure shortcuts in Settings → Custom commands, or connection config JSON:

```json
{"commands":[{"command":"summary","description":"Summarize a task","prompt":"Summarize task $ARGUMENTS and return its ORC link."}]}
```

`/summary task-123` expands the prompt after authorization/routing. `$ARGUMENTS` is literal string substitution, never shell evaluation. Without the placeholder, arguments are appended. Shortcuts cannot replace chat controls or expand project permissions. Native message overrides remain independent of shortcuts.

Questions and approvals reuse durable Attention requests. Buttons are bound to the originating sender, connection, recipient and thread. Plain text answers the single pending question offered to that conversation; multiple questions require explicit response instructions. Plain “yes” never grants approval. Sensitive requests remain in ORC; revoking project access or disabling approvals immediately blocks old controls.

## Delivery and recovery

- A provider-accepted receipt proves API acceptance, not that a human read it. Native IDs and immutable original destination are retained; moving a recipient alias cannot redirect message edits.
- Safe provider rate-limit responses may retry with bounded provider-specified delay. Ambiguous network outcomes never retry automatically. Multi-chunk partial send/edit outcomes are persisted for inspection.
- Native content fields such as `text`, `blocks` and `attachments` stay intact. Delivery-only overrides retain common Markdown rendering and long-message chunking. Explicit arrays replace generated arrays.
- Telegram polling cursors are persisted per connection/account. New setup ignores old backlog; reconnects resume new messages received during downtime. Already claimed/interrupted agent turns are not automatically replayed, preventing duplicate tool effects. Inspect the session before intentionally resending.
- Provider ownership leases prevent competing listeners within shared ORC storage. An external Telegram conflict stops until explicit configuration retry. Credential rotation refreshes the affected transport; Slack is ready only after its socket opens.

## Shared chat guidance and tool discovery

Channel conversations reuse the dashboard's configured chat system prompt. The shared baseline suggests reading relevant built-in ORC skills when real task work is needed: orc-sdlc for engineering and orc-platform for platform operations. Custom chat instructions are preserved. Meta mode is the default, so agents discover tools without receiving the full domain catalog up front. Full mode remains an explicit integration option.

Tool allowlists are a separate backend capability. Claude adapters enforce native tool restrictions; their existing ORC MCP namespace exception still allows ORC operations. Codex does not advertise allowlist enforcement, and unsupported explicit/profile allowlists are rejected rather than silently ignored. These allowlists are not an OS sandbox or an ORC operation permission policy. Channel recipient/project authorization and native human approval checks still apply independently.
