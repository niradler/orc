# Notifications

The bell in workspace and chat headers opens your notification menu on desktop
and phone. New arrivals show an unread indicator without opening the menu. Use
**Alt+N** or **Open notifications** in the command palette to open it.

Notifications cover human questions, approvals and commands, agent questions and
outcomes, and job outcomes. Open an item to review the request or visit its source.
Request forms stay collapsed until opened; drafts survive closing and reopening
the menu. Read and dismissed state is stored on the server and shared by clients.
Dismissal does not approve, answer, cancel or delete a source request.

![Notification menu on desktop with demo data](/screens/notification-center-light-1440.png)

![Notification menu in phone chat with demo data](/screens/notification-center-dark-390.png)

Job delivery follows `notify_on`: `never` creates no alert, `failure` reports
failed runs, and `always` also reports successful runs. Notification types are
extensible strings; unknown types use the same common menu and source link.

## Expiry and audit history

Every notification has an expiry date. **Settings → Storage → Automatic cleanup** sets
notification retention (default **30 days**) and audit retention (default
**90 days**), each from 1 to 3650 days. These are server-wide preferences.
All notifications expire, including unresolved ones. The underlying request has
its own timeout and lifecycle; notification expiry never resolves it.

Expired entries disappear from reads immediately. The API server cleans stored
rows at startup and every minute in bounded batches of 1000. A backlog drains
over successive passes. Lowering retention also hides older entries immediately.
SQLite reuses freed pages; cleanup does not guarantee a smaller database file.

**Activity → Audit** retains notification creation, resolution, read, dismissal
and expiry events independently, including the actual notification title and
message. Audit events expire under their own retention period even if the alert
has already been cleaned up. New lifecycle events also cover human-request
status changes, job starts/outcomes and task creation/status transitions.
They exclude unrelated source prompts, command payloads, responses and output.
Repeated polling and unchanged state do not create audit events. Existing audit
snapshots keep their original content until their retention period ends.

## Sound, push and channels

Desktop browsers show settled toasts; Needs-you alerts can chime and Done alerts
are silent. **Settings → Notifications → Sound** controls browser-local sound and
project muting. Browser/PWA push remains separately opt-in for background human
requests and chat replies; see [Installation](./install.md).

Telegram and Slack messaging already share `channel_send`, `channel_list` and
`channel_targets`, including provider-native overrides. Automatic forwarding of
these notification events, with opt-out and filters, is tracked in
[issue #212](https://github.com/niradler/orc/issues/212) and will reuse that API.

Old `/attention` and `/notifications` links open the notification menu.
See [Human requests](./human-requests.md) for source request actions and timeouts,
and [API reference](./api.md) for notification and audit routes.
