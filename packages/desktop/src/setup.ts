import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";

export function installCli(opts: {
  bin: string;
  version: string;
  home?: string;
  platform?: NodeJS.Platform;
}): { cli: string; binDir: string } {
  const home = opts.home ?? homedir();
  const win = (opts.platform ?? process.platform) === "win32";
  const binDir = join(home, ".orc", "bin");
  const cli = join(binDir, win ? "orc.exe" : "orc");
  const stamp = `${cli}.version`;

  const installed =
    existsSync(cli) && existsSync(stamp) && readFileSync(stamp, "utf-8") === opts.version;
  if (!installed) {
    mkdirSync(binDir, { recursive: true });
    const staging = `${cli}.tmp`;
    copyFileSync(opts.bin, staging);
    if (!win) chmodSync(staging, 0o755);
    renameSync(staging, cli);
    writeFileSync(stamp, opts.version);
  }
  return { cli, binDir };
}

const BLOCK_START = "# >>> orc >>>";
const BLOCK_END = "# <<< orc <<<";
const PATH_BLOCK = `${BLOCK_START}\nexport PATH="$HOME/.orc/bin:$PATH"\n${BLOCK_END}\n`;

export function loginShell(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.SHELL ?? "";
  let name = basename(fromEnv);
  if (!name) {
    try {
      name = basename(userInfo().shell ?? "");
    } catch {
      name = "";
    }
  }
  if (name === "zsh" || name === "bash" || name === "fish") return name;
  return process.platform === "darwin" ? "zsh" : "bash";
}

export function ensureOnPath(opts: {
  home?: string;
  platform?: NodeJS.Platform;
  shell?: string;
}): string[] {
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  if (platform === "win32") return [];
  const shell = opts.shell ?? loginShell();

  if (shell === "fish") {
    const file = join(home, ".config", "fish", "conf.d", "orc.fish");
    if (existsSync(file)) return [];
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'fish_add_path -g "$HOME/.orc/bin"\n');
    return [file];
  }

  const names =
    shell === "zsh"
      ? [".zshenv"]
      : platform === "darwin"
        ? [".bash_profile", ".bashrc"]
        : [".bashrc", ".profile"];
  const changed: string[] = [];
  for (const [index, name] of names.entries()) {
    const file = join(home, name);
    const present = existsSync(file);
    if (index > 0 && !present) continue;
    const current = present ? readFileSync(file, "utf-8") : "";
    if (current.includes(BLOCK_START)) continue;
    writeFileSync(
      file,
      `${current}${current && !current.endsWith("\n") ? "\n" : ""}\n${PATH_BLOCK}`,
    );
    changed.push(file);
  }
  return changed;
}

export function ensureOnWindowsUserPath(binDir: string): boolean {
  const script = [
    `$dir = '${binDir.replaceAll("'", "''")}'`,
    "$path = [string][Environment]::GetEnvironmentVariable('Path', 'User')",
    "if (($path -split ';') -contains $dir) { exit 3 }",
    "$updated = if ($path) { $path.TrimEnd(';') + ';' + $dir } else { $dir }",
    "[Environment]::SetEnvironmentVariable('Path', $updated, 'User')",
  ].join("; ");
  const result = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    stdio: "ignore",
    windowsHide: true,
  });
  return result.status === 0;
}

export function setLinuxAutostart(opts: { enabled: boolean; exec: string; home?: string }): void {
  const file = join(opts.home ?? homedir(), ".config", "autostart", "orc.desktop");
  if (!opts.enabled) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `[Desktop Entry]\nType=Application\nName=orc\nExec="${opts.exec}" --hidden\nX-GNOME-Autostart-enabled=true\n`,
  );
}
