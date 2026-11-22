# Desktop buddy

A physical desk display for ORC: an ESP32 "Cheap Yellow Display" (CYD) that shows
live session activity, needs-you alerts and notifications, with approve/deny from
the device. The project roadmap and hardware choice live in
[issue #514](https://github.com/niradler/orc/issues/514); this page covers the
`orc buddy` bridge that ships today.

The bridge composes a compact snapshot from the existing API — live sessions
(including child/subagent rollups), the notification inbox, pending human
requests and pending ORC chat approvals — and pushes it to a device over serial.
A terminal simulator renders the same protocol without any hardware. HTTP device
mode (the display talks to the API directly over WiFi) and BLE are later
milestones; the token and provisioning commands below already support them.

## Quick start (no hardware)

```bash
orc buddy --simulate
```

The simulator draws the buddy's mood, session counts, needs-you queue and recent
notifications, and sends the same commands a device would:

| Key | Action |
| --- | --- |
| `n` | Select the next actionable item |
| `a` | Approve the selected approval, or answer its first choice |
| `d` | Deny the selected approval |
| `r` | Mark the newest unread notification read |
| `q` | Quit |

## Serial device

```bash
orc buddy --list-ports            # find the display's port
orc buddy --port COM5             # or /dev/ttyUSB0 on Linux/macOS
```

Serial is 115200 8N1 by default (`--baud`). The CYD firmware that speaks this
protocol is the next milestone in [#514](https://github.com/niradler/orc/issues/514);
until it lands, `--simulate` exercises the full bridge path. Serial needs the
npm/bun install of ORC (native `serialport` bindings); standalone binaries ship
without them and support `--simulate`.

Common flags: `--url <api-base>` and `--token <token>` override the configured
API, `--project <id>` restricts the display to one project.

## What the device shows

| Mood | Meaning |
| --- | --- |
| `idle` | Connected, nothing running |
| `busy` | Sessions working — including parents whose children or background work run |
| `attention` | Something needs you: approval, question or a native terminal wait |
| `celebrate` | A completion arrived (holds a few seconds) |
| `error` | A session ended in error |
| `sleep` | Device-side: no snapshot for 30 seconds |

Approvals and option-based questions are actionable from the device; free-text
questions and native terminal prompts are shown but answered in ORC or the
terminal. Answers go through the same human-request and chat-permission routes
as the web app, with the same audit trail — the device never auto-approves.

## HTTP mode provisioning

The device stores a scoped access token, never the API secret:

```bash
orc buddy token --days 30                       # mint a device token (needs api.secret)
orc buddy config --port COM5 \
  --url http://192.168.1.20:7700 \
  --token <token> --ssid <wifi> --pass <wifi-password>
```

`config` pushes settings over serial into the device's NVS and waits for its
ack. Rotating the API secret revokes every minted token.

## Wire protocol (v1)

One UTF-8 JSON object per line (`\n` terminated), in both directions. Lines over
64KB are dropped; non-JSON lines (boot logs) are ignored.

Bridge → device, on every relevant change plus a keepalive every 10 seconds:

```json
{
  "v": 1,
  "t": 1775731234,
  "mood": "busy",
  "sessions": { "total": 4, "working": 2, "waiting": 1 },
  "needs_you": [
    {
      "id": "req_abc",
      "kind": "approval",
      "title": "Approve Bash",
      "hint": "rm -rf /tmp/foo",
      "project": "orc",
      "actionable": true
    }
  ],
  "recent": [{ "id": "n1", "line": "10:42 Agent finished", "unread": false }],
  "unread": 2,
  "tokens_today": 31200
}
```

`needs_you[].id` is the human-request id, `chat:<runId>:<requestId>` for an ORC
chat approval/question, or `native:<sessionId>` for a display-only terminal wait.
`tokens_today` is null when usage indexing has no entry for today.

Device → bridge commands (each expects an ack):

| Command | Payload | Effect |
| --- | --- | --- |
| `respond` | `id`, `decision: approve\|deny` | Answer an approval |
| `answer` | `id`, `choice` | Answer an option-based question |
| `read` | `id` | Mark a notification read |
| `ping` | — | Ack carries the bridge time |

Acks are `{ "ack": "<cmd>", "ok": true|false, "error"?: "…" }`. Bridge → device
commands use the same ack shape: `config` (provisioning fields `url`, `token`,
`ssid`, `pass`, `name`), `status`, `unpair`.

The bridge derives snapshots from `GET /api/events` (SSE), `/api/sessions/live`,
`/api/notifications`, `/api/human-requests` and `/api/chat/waiting`; chat
approval details come from the waiting thread's `/api/chat/threads/{id}/live`
replay. See the [REST API reference](./api.md).
