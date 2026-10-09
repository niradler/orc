# Portable packages and reusable agent launches

Status: The initial Packages catalog and configured terminal adapter are implemented.
See [the usage guide](agent-packages.md) for shipped behavior and capabilities.
Chat and flow adapters described below remain future extensions of the shared resolver.

## Problem and intended behavior

ORC currently lists OpenAPM packages on the Agents page. It imports and exports their files, discovers specialists and skills, and adds package instructions when an agent profile runs. It does not resolve APM dependencies, load Agent Plugins manifests, or select packages for an interactive terminal launch.

The intended workflow is **Packages → select a package → Run with… → Open in ORC terminal**. The user chooses an installed coding backend, a project folder, an optional specialist, and the packages to activate. Saving these selections creates a reusable agent setup that can also be selected in flows. Packages remain reusable across agents and projects.

## Reuse upstream tools

Use upstream APM and Vercel tooling rather than implementing another dependency manager or skill installer.

| Responsibility | Integration owner |
| --- | --- |
| APM dependency resolution, locking, installation and plugin packaging | Microsoft APM CLI |
| Skill source acquisition and supported agent deployment or temporary use | Vercel skills CLI |
| Catalog, original files, component attribution and validation diagnostics | ORC |
| Saved setups, capability checks and configured terminal/session launches | ORC |

APM supports portable Agent Plugins as dependencies and produces them with `apm pack --format agent-plugin`. Its default pack output is a different Claude plugin format. Its documented native portable-plugin activation path currently targets Copilot; acquisition and locking for another target do not establish runtime activation.

Vercel documents `skills add` for deployment and `skills use` for temporary skill use, including an interactive agent launch. Use its supported CLI entry point, not unpublished internal modules. Temporary single-skill launch does not by itself supply a multi-package launch contract or MCP activation.

References checked on 2026-10-09:

- [Microsoft APM](https://github.com/microsoft/apm)
- [APM pack formats](https://microsoft.github.io/apm/reference/cli/pack/)
- [APM native Agent Plugins installation](https://microsoft.github.io/apm/consumer/copilot-agent-plugins/)
- [Vercel skills CLI](https://github.com/vercel-labs/skills)
- [Agent Plugins specification](https://agent-plugins.org/specification)

## Shared layers

### Package catalog

Keep format-specific readers for OpenAPM and Agent Plugins behind one catalog. A catalog entry records an installed instance's identity, source format, original root, metadata, components, diagnostics and upstream provenance. Preserve original manifests and supporting files. Identify components by package instance and local component name so imports cannot silently overwrite unrelated packages or skills.

An Agent Plugin directory can be imported directly without `apm.yml`. APM dependencies that resolve to Agent Plugins enter the same catalog. If a source carries both manifests, use upstream classification rules for APM-managed sources and an explicit format choice for direct imports where classification is ambiguous.

Do not duplicate a component's activation: a native plugin registration and a loose skill/MCP deployment for the same backend must not both be applied.

### Agent setup and launch resolver

An ORC-owned saved setup references package instances, an optional agent profile, backend, optional model, permissions and a default project folder. Package manifests remain portable and are not rewritten to store ORC session preferences. Instructions, model choices and permissions are not part of the portable Agent Plugins core.

One launch resolver produces a description of the effective setup: selected components, instruction sources, tool policy, working directory, deployment or native registration actions, and compatibility errors. Backend adapters consume that description. Terminal and runtime launches must use the same resolution semantics even when their process APIs differ.

Check the actual resolved backend, including fallback, before starting. Refuse a launch that cannot enforce a required restriction. Display unsupported optional components and allow an explicit change of selection; do not silently claim an entire package is active.

Persist enough provenance to show what a session used and detect unavailable or changed sources when reusing or resuming a setup. Resume should not silently substitute a different configuration.

## Dashboard experience

Packages becomes the canonical location for both formats. Move package import, creation and inspection out of Agents, while preserving the existing Agents profile surface and linking specialists to their source package.

The package detail view shows metadata, source format, original files, available specialists, skills, MCP servers and validation issues. Actions are:

- **Import:** select a folder or use an upstream-supported source; preview before deployment.
- **Export package:** preserve the original directory format and supporting files.
- **Export for…:** generate a supported target artifact through an upstream adapter; explain components that cannot be represented.
- **Run with…:** choose the backend, folder, optional specialist, packages and prompt, then preview effective configuration.
- **Save as agent setup:** retain those choices for another session, project or flow.

**Open in ORC terminal** is the default Run destination. Dashboard chat can use the same setup in a later integration. Existing terminal readiness checks, authentication and worktree behavior remain applicable.

## Execution and specification requirements

Detect upstream executable availability and report an actionable setup state. Probe versions with a timeout. Qualify and pin the CLI versions used by integration tests; CLI flags and machine-readable output must be verified, not inferred from executable presence.

Invoke executables with separate arguments. Validate source, target and working-directory inputs. Preserve upstream admission gates and avoid blanket approval flags. Package inspection never executes scripts or starts MCP servers. Project deployment must track ownership and preserve unrelated configuration.

The API's configured terminal authentication requirement also applies to install, deployment and launch operations that execute code or alter runtime configuration. Package credentials remain client-managed; do not include them in exported packages, API diagnostics or logs. Bound subprocess time and output, support cancellation, and retain actionable errors without leaking credentials.

When ORC itself loads Agent Plugins, implement the applicable requirements directly: recognized locally bundled schemas, resolved filesystem containment, fixed discovery locations, narrow component failure boundaries and ignored unimplemented extensions. Stdio adapters supply persistent plugin data and the specified placeholders. Remote MCP adapters enforce transport, URL and header requirements. Supporting the package's layout alone is not a conformance claim.

## Delivery and validation

1. Qualify upstream CLIs on Windows and establish the shared adapter contract and capability report.
2. Add the common catalog and Agent Plugins reader beside existing OpenAPM support.
3. Add Packages and move existing package controls there; validate import, reload and original-format export.
4. Add saved setups and the shared resolver; wire configured launches into ORC terminals.
5. Connect flow selection and any runtime destinations supported by the qualified adapters.

Acceptance requires a real imported plugin to survive restart, make a skill accessible, connect a supported MCP server, launch an agent in an ORC terminal with its selected configuration, and export without losing original files. Verify existing APM specialists, instructions, skills and import/export behavior. Exercise same-name collisions, path escapes, malformed components, missing upstream tools, unsupported backends, subprocess failure, and restriction enforcement.

Use focused parser/adapter/API tests, typecheck and lint, then browser import/export and terminal launch checks. Mocked CLI argument tests are partial evidence; claims of upstream deployment and agent activation require real CLI and runtime checks.

## Current verification limits

Neither `apm` nor `skills` was found on PATH in the development environment during this review. Upstream runtime behavior has been checked in primary documentation, not exercised locally. The exact Windows invocation, supported CLI versions, multi-package activation strategy and non-Copilot portable-plugin activation must be qualified before implementation claims.
