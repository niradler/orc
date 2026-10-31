import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeProviderCode } from "./providers.js";

test("provider diagnostics accept only known codes and never raw errors or credentials", () => {
  expect(safeProviderCode("Channel provider: network_or_timeout")).toBe("network_or_timeout");
  expect(safeProviderCode("http_409_code_409")).toBe("http_409_code_409");
  for (const value of [
    "https://api.telegram.org/botPRIVATE/getUpdates",
    "PRIVATE",
    "private_token",
    "x".repeat(10000),
  ])
    expect(safeProviderCode(value)).toBe("provider_failure");
});

test("polling failure and recovery persist safe JSON log entries without repeating every poll", () => {
  const home = mkdtempSync(join(tmpdir(), "orc-channel-diagnostics-"));
  const program = `
    import { Database } from 'bun:sqlite';
    import { ChannelService } from ${JSON.stringify(new URL("./service.ts", import.meta.url).href)};
    import { ChannelStore } from '@orc/db/channels';
    let report;
    const service = new ChannelService(new ChannelStore(new Database(':memory:')), () => ({
      identity: async () => ({id:'bot',name:'bot'}), send: async () => '1', edit: async () => {},
      start: async (_receive, failed) => { report=failed; }, stop: async () => {},
    }));
    await service.save({id:'diagnostics',name:'diagnostics',provider:'telegram',enabled:true,credentials:{token:'PRIVATE'}});
    report('Channel provider: network_or_timeout');
    report('Channel provider: network_or_timeout');
    if(service.list()[0].status!=='error')throw Error('Failure status missing');
    report('');
    if(service.list()[0].status!=='ready')throw Error('Recovery status missing');
    report('');
    report('https://api.telegram.org/botPRIVATE/getUpdates');
    report('');
    await service.stop();
  `;
  const result = Bun.spawnSync([process.execPath, "-e", program], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      ORC_LOG_DIR: home,
      ORC_LOG_FILE: "1",
      ORC_LOG_LEVEL: "info",
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 15000,
  });
  expect(result.exitCode).toBe(0);
  const raw = readFileSync(join(home, "logs", "orc.log"), "utf8");
  expect(raw).not.toContain("PRIVATE");
  expect(raw).not.toContain("https:");
  const records = raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const failures = records.filter((row) => row.msg === "Channel transport failed");
  const recoveries = records.filter((row) => row.msg === "Channel transport recovered");
  expect(failures).toHaveLength(2);
  expect(recoveries).toHaveLength(2);
  expect(JSON.parse(failures[0].data)).toMatchObject({
    connection: "diagnostics",
    provider: "telegram",
    operation: "listen",
    code: "network_or_timeout",
  });
  expect(JSON.parse(recoveries[0].data)).toMatchObject({ code: "network_or_timeout", failures: 2 });
  expect(failures[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(JSON.parse(failures[1].data).code).toBe("provider_failure");
});
