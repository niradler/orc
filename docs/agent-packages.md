# Reusable agent packages

The dashboard's **Packages** page owns both OpenAPM (`apm.yml`) and portable
[Agent Plugins v1.0.0](https://agent-plugins.org/) (`plugin.json`). Agents remains
the editor for shared specialist profiles.

Import a package folder, inspect its original files, then choose **Run with**.
Select the coding agent, package tooling, project folder, optional model/profile
and starting prompt. **Save agent setup** retains these selections under
`~/.orc/agent-setups/`; reopen the setup from Packages to run it again.
**Open in ORC terminal** runs package preparation followed by the coding agent.
If preparation fails, the agent does not start. Terminal authentication and
capacity limits apply to these launches.

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
| Vercel skills | Skills-only portable Agent Plugin | Claude, Codex, Copilot | Bundled skills 1.7.2, Node.js >= 22.20 and the chosen agent CLI |

APM is installed separately on the API machine (`pip install apm-cli`);
`ORC_APM_PATH` can specify its executable. `ORC_COPILOT_PATH` selects a Copilot
executable for package launches. Vercel skills ships with the npm distribution;
standalone builds may use `skills` on PATH or `ORC_SKILLS_PATH`.

Deployment is **persistent and project-scoped**. APM extends the project's
`dependencies.apm` in `apm.yml`, retaining other configuration and existing
dependencies; serialization may reformat YAML. It then owns dependency
resolution, locking, target deployment and admission. Vercel copies selected
skills into its normal project destinations. Existing project configuration and
packages may also be available to the agent. ORC does not grant folder trust or
add permission-bypass flags. Resolve upstream trust/authentication/conflict
prompts in the terminal. Package code executes only through an explicit launch.

Portable plugins currently require Copilot for whole-plugin activation through
APM. A skills-only deployment rejects packages containing root `mcp.json`.
Shared specialist profiles currently require Claude so their instructions,
model and allowed tools can be applied explicitly. Other combinations fail
before launching instead of silently dropping those settings.

Imported plugin skills are discovered only at `skills/<name>/SKILL.md` and use
package-qualified identities in ORC. Invalid skills are isolated. Original
resources and unknown metadata remain available for inspection/export.
Agent Plugins supplies portable components, not a model or permissions profile;
ORC's saved setup remains separate from its manifest.

The shared resolver lives in `@orc/core/package-launch`. This release uses it
for configured terminals. Dashboard chat and task-flow attachment are future
adapters and do not currently consume saved setups.
