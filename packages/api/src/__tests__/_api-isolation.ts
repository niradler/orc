// Tests must never dial the production API port (the config default, 7700).
// Whatever else owns that port on a dev box can hang stray dials or amplify them
// into a socket cascade; with the prod daemon up, tests would create real human
// requests and run real rule actions against production. setupTestApp serves the
// app in-process, so outbound dialers (human-request waiters, rule actions, spec
// discovery, MCP) have no legitimate default target. Point ORC_API_BASE at an
// isolated loopback endpoint that answers 404 — a non-retryable failure, so waiters
// fail fast instead of polling a dead port until expiry. Files that need a live API
// override this with their own fixture server and restore it afterwards.
const probe = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => Response.json({ error: "isolated test endpoint" }, { status: 404 }),
});
process.env.ORC_API_BASE = `http://127.0.0.1:${probe.port}`;
