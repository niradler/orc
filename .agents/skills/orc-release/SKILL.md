---
name: orc-release
description: Run or resume the ORC release protocol, verify published artifacts, and update requested desktop or homelab installations. Use for ORC release, installation upgrade, or lab rollout requests.
---

# ORC release

Read [the release operator protocol](../../../docs/releases.md), including its
commands and operator protocol, and the latest `.claude/docs/releases.md` handoff
if present. Refresh ORC context and effective guidance as required by the repo's
agent instructions. The protocol is authoritative; the handoff is historical
evidence, so verify current source, checkpoints, services and installations.

Follow the requested scope: a release, desktop upgrade and lab rollout are distinct
actions. Use the canonical release command and its checkpoints; preserve unfinished
state and accepted or uncertain npm submissions. Do not push `master` without
fresh explicit approval. Do not infer permission for an extra deployment or for
paid runners from release authorization.

Before replacing an installation, inspect active work, preserve a private
consistent backup and prior image or binary, and test the actual migrations on a
copied database. For a lab, inspect its current Compose configuration and custom
patches, pin the verified immutable release image, and preserve its settings and
mounts. Reinspect and adapt any version-specific helper before using it.

After installation, verify actual versions, intended authentication, dashboard and
assets, source data, database integrity, and the other installation-specific checks
in the protocol. When startup retention changes counts, investigate against the
backup, logs and retention criteria; do not silently waive discrepancies. Record
evidence and recovery locations in the handoff, and clearly report any unfinished
publication, installation, data discrepancy or verification.
