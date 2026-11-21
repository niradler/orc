// Tests must never dial the production API port (the config default, 7700).
// On a dev box something else may own that port — a service that accepts and
// then hangs turns "API unreachable" assertions into test timeouts — and a live
// prod daemon would leak real data into the suite. Point the default base at an
// isolated loopback endpoint that always fails fast, matching CI where nothing
// listens on the default port. Files that need a live API override ORC_API_BASE
// with their own fixture and restore this value afterwards.
const probe = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response("isolated test endpoint", { status: 503 }),
});
process.env.ORC_API_BASE = `http://127.0.0.1:${probe.port}`;
process.on("exit", () => probe.stop(true));
