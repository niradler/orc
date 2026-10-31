import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { execHostFor, hostHome } from "@orc/core/exec-host";
import { HumanRequestStore } from "@orc/db/human-requests";
import { prepareCommand } from "../src/lib/command-request.js";

// Run only against an explicitly selected SSH test fixture, using its existing SSH config.
const alias = process.env.ORC_COMMAND_TEST_HOST;
assert.ok(alias, "Select an isolated SSH fixture with ORC_COMMAND_TEST_HOST");
const host = execHostFor(alias);
const home = await hostHome(host);
const db = new Database(":memory:");
try {
  const store = new HumanRequestStore(db);
  const request = store.create({
    kind: "command",
    prompt: "Verify SSH command folder expansion",
    origin: { backend: "test", session_id: "ssh-fixture", request_id: "home-folder" },
    command: {
      host: host.kind === "ssh" ? host.alias : null,
      cwd: "~",
      script: "pwd",
      timeout_seconds: 5,
      arguments: [{ name: "VALUE", label: "Synthetic test value" }],
    },
  });
  const prepared = await prepareCommand(request, {
    version: request.version,
    script: 'test -n "$ZSH_VERSION$BASH_VERSION" || exit 19; pwd; printf "%s" "$ORC_INPUT_VALUE"',
    values: { VALUE: "synthetic-command-fixture-value" },
  });
  const claimed = store.claimCommand(request.id, request.version);
  const completed = store.completeCommand(request.id, claimed.version, await prepared.execute());
  assert.equal(completed.status, "answered");
  assert.equal(completed.response?.kind, "command");
  if (completed.response?.kind === "command") {
    assert.equal(completed.response.exit_code, 0);
    assert.equal(completed.response.stdout, `${home}\n[REDACTED]`);
    assert.equal(completed.response.stderr, "");
  }
  console.log("SSH home-folder execution and redaction passed");
} finally {
  db.close();
}
