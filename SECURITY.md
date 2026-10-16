# Security Policy

## Reporting a vulnerability

Please report security issues privately via [GitHub Security Advisories](https://github.com/niradler/orc/security/advisories/new)
rather than opening a public issue. We aim to acknowledge reports within a few days.

## Security model — read before exposing ORC to a network

ORC is a local-first orchestration tool. By design it can execute arbitrary work on the host:

- **Jobs run arbitrary shell commands.** Creating or triggering a job (`sh -c <command>`) is equivalent
  to running commands as the user that started ORC. Jobs inherit the server process environment, so they
  can read any secret available to it (API keys, tokens).
- **MCP tools and the REST API expose the full surface.** `job_run`, `skill_create`, `kb_write`,
  memory and task writes are all reachable by any authenticated client — and by *any* client if no secret is set.
- **There is one principal.** Knowledge base edit rules are by call source (`editable_by`: ui, cli, api, mcp).
  The source is fixed for MCP tool calls, and MCP cannot change knowledge base or knowledge settings. Over REST
  the `X-Orc-Source` header is chosen by the caller, so anything holding the API secret can act as any source
  and as the owner. Actor names and session IDs are attribution, not authentication.
- **Stored secrets.** An embedding API key saved from Settings is encrypted (AES-256-GCM) with a per-machine key
  in `~/.orc/secret.key` and never returned by the API. Anyone who can read both files can decrypt it; protect
  `~/.orc` like any credential store. Keys set through environment variables are not stored.

### Hardening checklist

- **Set `ORC_API_SECRET`** (or `api.secret` in `~/.orc/config.json`) whenever ORC binds to anything other than
  `127.0.0.1`. Generate a strong value, e.g. `openssl rand -hex 32`. The Docker image binds `0.0.0.0`, so this
  applies to all container deployments that map the port beyond localhost.
- ORC logs a loud warning at startup if it is bound to a non-loopback host with no secret configured.
- The `/health` endpoint is intentionally unauthenticated (for container/orchestrator probes); everything else
  requires the bearer token once a secret is set.
- Treat anyone with API/MCP access as having shell access to the host. Do not expose ORC directly to untrusted
  networks; put it behind a reverse proxy with TLS and additional access controls if remote access is required.

## Supported versions

Security fixes are applied to the latest released version on the `master` branch.
