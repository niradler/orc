# Channels: messages, setup and inbound routing

Channels are bidirectional: an approved inbound message can invoke an agent through an ordered route; an authorized agent can send independently through MCP or HTTP API. Settings > Channels manages connections, recipients and rules. Telegram and Slack are initially supported.

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

Telegram: use BotFather to obtain a bot token or select `ORC_TELEGRAM_TOKEN` in Settings. Save and verify the bot, enable the connection, then use Pair my Telegram. Open the expiring link, start the bot and confirm the candidate user/chat in authenticated Settings. This creates `me` for outbound messaging; inbound and Attention are separate opt-ins. ORC uses long polling. A webhook or another active poller is an ownership conflict; do not delete a webhook or steal the bot automatically.

Slack: copy the manifest in Settings, create/install a Slack app in the intended workspace, enable Socket Mode, and configure the bot token and app token (`connections:write`). `ORC_SLACK_BOT_TOKEN` and `ORC_SLACK_APP_TOKEN` are supported. Verify the workspace. Pair a private DM through Pair my Slack, or configure an approved channel ID and sender IDs manually. Invite the bot to channel destinations. Permissions and event subscriptions must cover the selected conversation types; inspect provider errors such as `missing_scope`, `not_in_channel`, or `channel_not_found`.

Pairing is short-lived, single-use and requires authenticated confirmation. Only one listener owns a provider account. Secrets are server-side encrypted or referenced through environment variables and are never returned to agents or the browser. Never paste bot credentials into an MCP message, scratchpad or job prompt.

## Ordered inbound routing

Enable inbound on an approved destination and list allowed sender IDs. Authorization precedes routing. Rules run in saved order; the first enabled matching rule wins. No match launches no agent. An ignore rule stops routing. No implicit fallthrough into a general-purpose agent handler is allowed.

Simple rules can use the Settings editor; advanced JSON supports `all`, `any` and `not`, with at most five levels and 100 condition nodes. Predicates have `field`, `op`, and `value`. Fields: `sender`, `chat`, `thread`, `text`, `command`, `is_direct`, `is_mention`, `kind`. Operators: `is`, `in`, `contains`, `starts_with`. `in` uses a string array; boolean comparisons use JSON booleans. Comparisons are case-sensitive. No arbitrary scripts or unbounded regular expressions.

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

An agent action names its backend and project; optional `profile` selects an existing agent profile. The project needs an active scope directory available on the configured execution host. Sessions are separated by connection, chat/thread, sender and route/action. Agent replies return through the original destination. Pairing and Attention commands are handled before ordinary routing. Native button callbacks have `kind: "action"`; their value (or Slack action ID when no value exists) is untrusted input that can reach an agent only through an authorized matching route. New rules default to `kind: "message"`; use an action rule to handle custom buttons. A rule without a kind condition can match either kind. A callback never directly executes a command or bypasses native permissions.

Use the saved-rule preview in Settings, or `POST /api/channels/{id}/route-test`, to test authorization and rule matching without invoking an agent.

## Questions, approvals and delivery

Use existing `human_request` / `human_request_get` / `human_request_acknowledge` tools for durable questions and approvals. Select provider notifications with `notify`; the destination must opt into Questions and approvals. Channel-native agent requests enter the same Attention store. `/attention` replies are bound to the offered connection, recipient, chat/thread, request version and expiry. Approval messages do not bypass ORC rules or native permissions.

`accepted` means the provider accepted a message, not that Nir read it. `failed` means a definite provider rejection; `unknown` means the request may have reached the provider; `partial` means some chunks succeeded. Inspect unknown/partial outcomes before retrying. The same idempotency key and identical request return the same receipt; reusing a key with different content conflicts. Never promise exactly-once delivery across network failures.

Receipt/idempotency metadata and inbound duplicate records are retained for 30 days. Expired pairing/action metadata is pruned after a further day. Queued invocations recheck current authorization and routing before execution. Editing a recipient does not redirect an already running agent's reply. A detected competing Telegram poller leaves the connection stopped; resolve the conflict and save explicitly to retry.

HTTP API: provider discovery and `/channels`; `PUT /channels/{id}` for revision-checked configuration; `/channels/{id}/verify`, `/targets`, `/pairings`, `/route-test`; `/channels/pairings/{id}` and `/confirm`; `POST /channels/messages`; `GET`/`PATCH /channels/messages/{id}`. Prefix paths with `/api`. API and MCP use the same service and validation. The SDK exposes `channels` methods. Routine agent MCP does not expose credential/setup writes.

Definitions live in SQLite (`channels`, `channel_targets`, `channel_routes`). Provider configuration and encrypted credential references are JSON fields; rule order is explicit. Preserve the returned `revision` when saving configuration; reload on a conflict rather than overwriting someone else's changes.
