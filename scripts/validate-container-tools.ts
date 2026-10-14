import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { probeBackends } from "../packages/agent-runtime/src/index.js";
import { createApp } from "../packages/api/src/server.js";
import { loadConfig } from "../packages/core/src/config.js";
import { closeDb } from "../packages/db/src/client.js";

const secret = randomUUID();
loadConfig({
  activeProject: "",
  api: { host: "127.0.0.1", port: 7700, secret },
  db: { path: "/tmp/orc-container-probe.db" },
  knowledge: {
    db_path: "/tmp/orc-container-knowledge.db",
    default_limit: 10,
    search_mode: "lexical",
  },
});
const app = createApp();
try {
  for (const command of [
    ["node", "--version"],
    ["acpx", "--version"],
    ["codex", "--version"],
    ["claude", "--version"],
  ]) {
    const process = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", timeout: 30000 });
    const output = await new Response(process.stdout).text();
    assert.equal(await process.exited, 0, `${command[0]} failed`);
    console.log(`${command[0]}: ${output.trim()}`);
  }
  assert.equal((await app.request("/api/projects")).status, 401);
  const projects = await app.request("/api/projects", {
    headers: { Authorization: `Bearer ${secret}` },
  });
  assert.equal(projects.status, 200);
  const backends = await probeBackends();
  assert.equal(backends.find((backend) => backend.name === "acpx")?.available, true);
  const codex = backends.find((backend) => backend.name === "codex-cli");
  assert.equal(
    codex?.available,
    false,
    "Credential-free image must not claim authenticated Codex readiness",
  );
  assert.match(codex?.error ?? "", /not authenticated/);
  console.log(
    JSON.stringify(
      backends.map(({ name, available, requires, error }) => ({
        name,
        available,
        requires,
        error,
      })),
      null,
      2,
    ),
  );
  console.log(
    "Private API auth and container tool probes passed; no real agent credentials supplied.",
  );
} finally {
  closeDb();
}
