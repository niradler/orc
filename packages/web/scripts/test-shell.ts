import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function configureTestShell(
  home: string,
  platform: NodeJS.Platform = process.platform,
  which: (command: string) => string | null = Bun.which,
): void {
  if (platform !== "win32") return;
  const executable = which("pwsh") ?? which("powershell");
  if (!executable) throw new Error("Windows browser tests require PowerShell");
  // Windows resolves Documents profiles independently of HOME/USERPROFILE.
  const directory = join(home, ".orc");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "config.json"),
    JSON.stringify({ terminals: { shell: [executable, "-NoLogo", "-NoProfile"] } }),
    { flag: "wx", mode: 0o600 },
  );
}
