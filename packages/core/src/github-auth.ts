import { loadConfig } from "./config.js";
import { hostExec, resolveExecHost } from "./exec-host.js";

interface GithubAuthDeps {
  run: (args: string[]) => Promise<{ code: number | null; stdout: string }>;
  token?: string | undefined;
}

export async function resolveGithubAuth(
  deps: GithubAuthDeps = {
    run: (args) => hostExec(resolveExecHost(), args, { timeoutMs: 15000 }),
    token: loadConfig().github.token,
  },
): Promise<{ source: "gh" | "token" | "none"; token?: string }> {
  try {
    const result = await deps.run(["gh", "auth", "token", "--hostname", "github.com"]);
    if (result.code === 0 && result.stdout.trim())
      return { source: "gh", token: result.stdout.trim() };
  } catch {
    // Unavailable host credentials fall back to the configured token or public access.
  }
  if (deps.token) return { source: "token", token: deps.token };
  return { source: "none" };
}
