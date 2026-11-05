# Dashboard updates

The dashboard uses one authenticated `GET /api/events` SSE connection per browser tab.
It fetches initial snapshots when views mount and refreshes affected queries after a
`change` event. There are no periodic dashboard HTTP refreshes. Terminal input/output
continues to use its existing per-terminal WebSocket.

The stream accepts the API's normal Bearer header. The browser uses streaming fetch
so credentials stay in headers. Event payloads contain resource names, not records,
commands, paths or secrets:

```text
event: ready
data: {}

event: change
data: {"resources":["tasks","terminals"]}
```

`ready` means the subscription is active. Clients refresh their snapshots on each
connection, including reconnects; this protocol does not promise durable event replay.
Refreshes account for events arriving while an older snapshot is still being fetched.
Inactive queries are marked stale and fetch when opened.

The server sends a comment keepalive every 25 seconds. These are bytes on the existing
connection, not new requests or data refreshes. The browser reconnects after a lost
connection, closes the stream while offline, and detects silent streams with a 60-second
inactivity deadline. Health indicators reflect the stream connection state.

Database revision triggers track committed resource changes, including other connections
writing the same SQLite database. In-process statement notifications and native DB/WAL
filesystem notifications wake the revision reader; it does not poll. No-op updates and
rolled-back transactions do not produce resource changes.

Terminal lifecycle changes publish directly. File-backed resource and checkout watchers
publish filesystem changes. Shared checkout watchers are released after the last stream
disconnects. SSH checkout watchers use blocking Linux inotify through the Python/SSH
infrastructure; watcher failures are logged and their connection is retried.

Session discovery runs once initially, then responds to filesystem changes, native
process-exit notifications, and one-shot activity-expiry deadlines. POSIX process-exit
notifications require Python 3 with `pidfd_open` (Linux) or `kqueue` (macOS); Windows uses
PowerShell's native process wait. Watcher failures are logged rather than hidden behind
periodic refreshes. Scheduled jobs, the agent task loop, timeout sweeps and transport
keepalives retain their separate scheduling roles.

Reverse proxies must allow streaming responses without buffering and keep the connection
open between keepalives. The endpoint sends `X-Accel-Buffering: no` and
`Cache-Control: no-cache, no-transform`; deployment proxy behavior must be checked when
deploying this change.
