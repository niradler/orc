# Reusable agent packages

The dashboard's **Packages** page owns both OpenAPM (`apm.yml`) and portable
[Agent Plugins v1.0.0](https://agent-plugins.org/) (`plugin.json`). Agents remains
the editor for shared specialist profiles.

Import a package folder, inspect its original files, then choose **Use package**.
Select the coding agent, local or configured SSH host, working folder, and chat
or terminal destination. An ORC project is optional: its folder can fill the path,
which remains editable. **Browse** lists folders on the selected SSH host or opens
the local folder picker. Saved agent definitions have the same **Launch agent** dialog.
Terminal launches run preparation before starting the agent. Chat launches wait
for preparation before opening a persistent conversation; use a terminal if an
installer needs trust, authentication or conflict prompts. Chat supports Claude
and Codex; Copilot uses the terminal destination.

**Export package** downloads a ZIP preserving the original manifest and assets.
The CLI's `orc agent-package import <folder>` and
`orc agent-package export <name> <new-folder>` support both formats too.
When a folder has both manifests, choose the desired format explicitly in the UI.
The CLI uses OpenAPM when `apm.yml` is present.

## Supported deployment routes

| Tooling | Packages | Agent | Requirements |
| --- | --- | --- | --- |
| Microsoft APM | OpenAPM | Claude, Codex, Copilot | APM >= 0.33.0 and the chosen agent CLI |
| Microsoft APM | Whole portable Agent Plugin, including native MCP configuration | Copilot | APM >= 0.33.0, Copilot >= 1.0.81, Git repository root |
| Native Codex plugin installer | Whole portable Agent Plugin, including skills, MCP and assets | Codex | Codex CLI >= 0.162.1 |
| Vercel skills | Skills-only portable Agent Plugin | Claude, Codex, Copilot | Bundled skills 1.7.2, Node.js >= 22.20 and the chosen agent CLI |

APM and coding-agent executables must already be installed on the selected host.
The **Install for coding agent** action applies package configuration; it does not
install APM, Bun, or the coding-agent executable. Bun is required for preparation.
On the API machine,
`ORC_APM_PATH` can specify its executable. `ORC_COPILOT_PATH` selects a Copilot
executable for package launches. Vercel skills ships with the npm distribution;
standalone builds may use `skills` on PATH or `ORC_SKILLS_PATH`.

Deployment is persistent. For SSH, ORC transfers selected source files to a private
staging folder under the working folder's `.orc/` directory before preparation.
APM extends the working folder's
`dependencies.apm` in `apm.yml`, retaining other configuration and existing
dependencies; serialization may reformat YAML.
ORC replaces earlier generated SSH source entries for the selected package on
relaunch, preserving user-managed dependencies and other package selections.
APM then owns dependency resolution, locking, target deployment and admission. Vercel copies selected
skills into its normal project destinations. Existing project configuration and
packages may also be available to the agent. ORC does not grant folder trust or
add permission-bypass flags. Resolve upstream trust/authentication/conflict
prompts in the terminal. Package code executes only through an explicit launch.

Codex uses its native marketplace and plugin commands for whole plugins. The
source snapshot stays under `.orc/plugin-marketplaces/` in the working folder;
each revision has a fresh content snapshot while its installed identity stays
stable, so removed files do not remain active after reinstalling.
The installed plugin and activation settings live in Codex's user cache/config
on that host and can be available to other Codex sessions. Original catalog files
are preserved. Copilot continues to use APM native registration.
A skills-only deployment rejects packages containing root `mcp.json`.
Shared specialist instructions and model selection support Claude and Codex;
profiles with an explicit tool allowlist require Claude. Other combinations fail
before launching instead of silently dropping those settings.
On SSH, standalone agent instructions are applied but their referenced supporting
files are not transferred; those paths must already be accessible on that host.

Imported plugin skills are discovered only at `skills/<name>/SKILL.md` and use
package-qualified identities in ORC. Invalid skills are isolated. Original
resources and unknown metadata remain available for inspection/export.
Agent Plugins supplies portable components, not a model or permissions profile;
ORC's saved setup remains separate from its manifest.

The shared resolver lives in `@orc/core/package-launch`; the API's host preparation
adapter serves terminal, chat and copied-command actions. Launch host selection
does not change the installation's default SSH host. Existing SSH platform support
still applies: the API must run on Linux, macOS or in Docker for SSH connection sharing.
