# Skills, profiles and packages

Sources: [Skills](https://github.com/niradler/orc/blob/master/README.md#skills),
[Agent packages](https://github.com/niradler/orc/blob/master/docs/agent-packages.md).

## Discover and load

ORC ships two entry points: `orc-platform` for operating the product and `orc-sdlc`
for engineering process. `skill_list` returns metadata; `skill_read` returns the
effective entry instructions and file inventory. Load a supporting file with
`skill_read({name, ref: "references/knowledge.md", project})`. Bare reference
filenames are supported; paths resolve from the skill root, never the repo cwd.
Reads do not execute scripts. Binary content uses explicit base64 encoding.

Built-ins live in the distribution, user skills in `~/.orc/skills/`, and authored
instruction changes can be global or project-scoped. Built-in names take precedence
over same-named user folders; project instruction overrides take precedence over
global ones. Read the effective version before acting and refresh at work-unit
boundaries or after compaction. Do not synchronize process bodies into every
coding client's local skills; MCP is the central discovery/read interface.

Old built-in names remain named-read compatibility routes for saved tasks and
flows; they are not extra discovery entries. New definitions should use the two
entry points. Explicit legacy authored overrides remain readable under their names.
Managed workers/reviewers also receive applicable authored legacy supplements with
name/scope/change provenance. Unmodified retired playbooks are not reinjected;
worker and reviewer instructions are kept in their own roles. Reconcile a conflict
explicitly before changing either authored version; no automatic overlay rewrite.
Built-in discovery toggles hide metadata, not named reads or execution. Authored
overrides and user/imported skills retain their normal visibility rules.

## Author and edit

A skill is a folder with `SKILL.md` (name/description frontmatter), plus only useful
references, scripts or assets. Keep selection and shared constraints in the entry;
group related details into references loaded when needed. Prefer a few coherent
references over a file per operation. Avoid generic agent personas, repeated
lifecycle rules and exhaustive API/CLI manuals.

For audited instruction edits, read raw `SKILL.md`, then `skill_update` with
`expected_content`, scope, reason and session ID when available. Reconcile conflicts
against the current version. This edits entry instructions, not supporting files;
use the dashboard/file APIs for authored supporting text. Preserve original assets
and local edits. Verify save/reopen and effective reads in the intended scope.

Folder import/export preserves supporting content:

```sh
orc skill create my-workflow --directory ./my-workflow
orc skill read my-workflow --ref references/guide.md
orc skill validate ./my-workflow
orc skill export my-workflow ./exported/my-workflow
```

For GitHub import, inspect `orc skill import <owner/repo> --list`, choose the actual
skill, then import. Existing names are not overwritten. Sync compares each file
with its imported baseline; local/upstream conflicts require review, not blind
replacement. Review the pinned source and licenses before running imported scripts.
Paths must remain inside the skill; symlinks/traversal and oversize bundles are rejected.

## Agent profiles and portable packages

A profile defines specialist instructions/model/tools; a backend selects how an
agent runs. Neither is an SDLC flow. ORC supports APM `.agent.md` profiles and
portable packages; inspect/import/read using the current agent/package tools or
Packages dashboard. Standalone profiles live in `~/.orc/agents/`; project profiles
can override shared IDs. Preserve authored manifests, relative paths and assets.

Check the backend can honor declared model/tool restrictions before launch.
Unsupported restrictions must fail rather than silently run unrestricted.
Profile handoffs are declarations; ORC flow edges control managed execution.
Package dependency installation and deployment can execute code or change project
configuration: inspect the planned operation and use the user's scope. Do not
include client credentials in exported packages. Verify the prepared project and
actual launched session, not only that an import succeeded.
