import { expect, spyOn, test } from "bun:test";
import * as configModule from "./config.js";
import * as execHostModule from "./exec-host.js";
import { resolveGithubAuth } from "./github-auth.js";

test("should run gh on the configured SSH host and use local execution when SSH is unset", async () => {
  const config = configModule.loadConfig();
  const configMock = spyOn(configModule, "loadConfig").mockReturnValue({
    ...config,
    ssh: { ...config.ssh, host: "github-host" },
  });
  const calls: string[] = [];
  const execute = spyOn(execHostModule, "hostExec").mockImplementation(async (host, argv, opts) => {
    calls.push(host.kind === "ssh" ? host.alias : "local");
    expect(argv).toEqual(["gh", "auth", "token", "--hostname", "github.com"]);
    expect(opts?.timeoutMs).toBe(15000);
    return { code: 0, stdout: "host-secret\n", stderr: "" };
  });
  try {
    expect(await resolveGithubAuth()).toEqual({ source: "gh", token: "host-secret" });
    configMock.mockReturnValue({ ...config, ssh: { connect_timeout_secs: 10 } });
    expect(await resolveGithubAuth()).toEqual({ source: "gh", token: "host-secret" });
    expect(calls).toEqual(["github-host", "local"]);
  } finally {
    execute.mockRestore();
    configMock.mockRestore();
  }
});

test("should reuse gh credentials before falling back to the configured token", async () => {
  expect(
    await resolveGithubAuth({
      run: async (args) => {
        expect(args).toEqual(["gh", "auth", "token", "--hostname", "github.com"]);
        return { code: 0, stdout: "gh-secret\n" };
      },
      token: "configured-secret",
    }),
  ).toEqual({ source: "gh", token: "gh-secret" });
  expect(
    await resolveGithubAuth({
      run: async () => {
        throw new Error("not installed");
      },
      token: "configured-secret",
    }),
  ).toEqual({ source: "token", token: "configured-secret" });
  expect(await resolveGithubAuth({ run: async () => ({ code: 1, stdout: "" }) })).toEqual({
    source: "none",
  });
});
