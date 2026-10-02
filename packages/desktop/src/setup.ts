import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function installCli(opts: {
  bin: string;
  version: string;
  home?: string;
  platform?: NodeJS.Platform;
}): { cli: string; linked: boolean } {
  const home = opts.home ?? homedir();
  const win = (opts.platform ?? process.platform) === "win32";
  const cli = join(home, ".orc", "bin", win ? "orc.exe" : "orc");
  const stamp = `${cli}.version`;

  const installed =
    existsSync(cli) && existsSync(stamp) && readFileSync(stamp, "utf-8") === opts.version;
  if (!installed) {
    mkdirSync(dirname(cli), { recursive: true });
    const staging = `${cli}.tmp`;
    copyFileSync(opts.bin, staging);
    if (!win) chmodSync(staging, 0o755);
    renameSync(staging, cli);
    writeFileSync(stamp, opts.version);
  }
  if (win) return { cli, linked: false };

  const link = join(home, ".local", "bin", "orc");
  try {
    return { cli, linked: lstatSync(link).isSymbolicLink() && readlinkSync(link) === cli };
  } catch {
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(cli, link);
    return { cli, linked: true };
  }
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
