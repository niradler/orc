import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@orc/core/config";
import { startGateway, stopGateway } from "@orc/gateway";
import { startScheduler, startWatchers, stopScheduler, stopWatchers } from "@orc/runner";
import { createOrcClient } from "@orc/sdk/client";
import { Command } from "commander";

export const ORC_HOME = process.env.ORC_HOME ?? join(homedir(), ".orc");
export const ORC_LOG = join(ORC_HOME, "daemon.log");
export const ORC_PID = join(ORC_HOME, "daemon.pid");

const TASK_NAME = "OrcDaemon";
const LAUNCHD_LABEL = "com.orc.daemon";
const LAUNCHD_PLIST = join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
const SYSTEMD_UNIT = join(homedir(), ".config", "systemd", "user", "orc-daemon.service");

function resolveOrcBin(): string {
  // Standalone binary — process.execPath IS the orc binary
  if (!process.execPath.includes("node") && !process.execPath.includes("bun")) {
    return process.execPath;
  }
  // npm global install — find `orc` on PATH
  try {
    const p = execSync(platform() === "win32" ? "where orc" : "which orc", {
      encoding: "utf-8",
    }).trim();
    return p.split(/\r?\n/)[0] ?? "orc";
  } catch {
    return "orc";
  }
}

function installWindows(): void {
  const bin = resolveOrcBin();
  const cmd = `"${bin}" daemon start`;
  execSync(
    `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "${TASK_NAME}" /t REG_SZ /d "${cmd}" /f`,
    { stdio: "inherit" },
  );
  console.log(`\n  Installed registry Run key "${TASK_NAME}" (runs at logon, no admin needed).`);
  console.log(`  View:    reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "${TASK_NAME}"`);
}

function installMacos(): void {
  const bin = resolveOrcBin();
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bin}</string>
    <string>daemon</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${ORC_LOG}</string>
  <key>StandardErrorPath</key>
  <string>${ORC_LOG}</string>
</dict>
</plist>`;

  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(LAUNCHD_PLIST, plist);
  try {
    execSync(`launchctl unload "${LAUNCHD_PLIST}"`, { stdio: "ignore" });
  } catch {}
  execSync(`launchctl load "${LAUNCHD_PLIST}"`, { stdio: "inherit" });
  console.log(`\n  Installed launchd agent "${LAUNCHD_LABEL}" (runs at login, auto-restart).`);
  console.log(`  Plist:   ${LAUNCHD_PLIST}`);
  console.log(`  Manage:  launchctl list | grep orc`);
}

function installLinux(): void {
  const bin = resolveOrcBin();
  const unit = `[Unit]
Description=ORC Daemon — API + scheduler + gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${bin} daemon start
Restart=on-failure
RestartSec=5
StandardOutput=append:${ORC_LOG}
StandardError=append:${ORC_LOG}

[Install]
WantedBy=default.target
`;

  mkdirSync(join(homedir(), ".config", "systemd", "user"), { recursive: true });
  writeFileSync(SYSTEMD_UNIT, unit);
  execSync("systemctl --user daemon-reload", { stdio: "inherit" });
  execSync("systemctl --user enable --now orc-daemon.service", { stdio: "inherit" });
  console.log(`\n  Installed systemd user service "orc-daemon" (auto-start, restart on failure).`);
  console.log(`  Unit:    ${SYSTEMD_UNIT}`);
  console.log(`  Manage:  systemctl --user status orc-daemon`);
}

function uninstallWindows(): void {
  try {
    execSync(
      `reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "${TASK_NAME}" /f`,
      { stdio: "inherit" },
    );
    console.log(`  Removed registry Run key "${TASK_NAME}".`);
  } catch {
    console.log(`  No registry Run key "${TASK_NAME}" found.`);
  }
}

function uninstallMacos(): void {
  if (existsSync(LAUNCHD_PLIST)) {
    try {
      execSync(`launchctl unload "${LAUNCHD_PLIST}"`, { stdio: "ignore" });
    } catch {}
    unlinkSync(LAUNCHD_PLIST);
    console.log(`  Removed launchd agent "${LAUNCHD_LABEL}".`);
  } else {
    console.log(`  No launchd plist found at ${LAUNCHD_PLIST}.`);
  }
}

function uninstallLinux(): void {
  try {
    execSync("systemctl --user disable --now orc-daemon.service", { stdio: "ignore" });
  } catch {}
  if (existsSync(SYSTEMD_UNIT)) {
    unlinkSync(SYSTEMD_UNIT);
    execSync("systemctl --user daemon-reload", { stdio: "ignore" });
    console.log(`  Removed systemd user service "orc-daemon".`);
  } else {
    console.log(`  No systemd unit found at ${SYSTEMD_UNIT}.`);
  }
}

function ensureOrcHome() {
  mkdirSync(join(ORC_HOME, "logs"), { recursive: true });
}

export function readDaemonPid(): number | null {
  try {
    return Number(readFileSync(ORC_PID, "utf-8").trim());
  } catch {
    return null;
  }
}

function writePid() {
  writeFileSync(ORC_PID, String(process.pid));
}

function removePid() {
  try {
    require("node:fs").unlinkSync(ORC_PID);
  } catch {}
}

export function daemonCommand() {
  const cmd = new Command("daemon").description(
    "Run the API + scheduler + file watchers + gateway as one persistent process",
  );

  cmd
    .command("start", { isDefault: true })
    .description("Start the daemon (use global --port / --host / --db / --secret to configure)")
    .action(async () => {
      ensureOrcHome();

      const existingPid = readDaemonPid();
      if (existingPid) {
        try {
          process.kill(existingPid, 0);
          console.error(`[orc] daemon already running (pid ${existingPid}). Use: orc daemon stop`);
          process.exit(1);
        } catch {
          // stale pid
        }
      }

      const config = loadConfig();

      writePid();
      await import("@orc/api");
      console.log(`[orc] home     ${ORC_HOME}`);
      console.log(`[orc] db       ${config.db.path}`);
      console.log(`[orc] API      http://${config.api.host}:${config.api.port}`);
      console.log(`[orc] pid      ${process.pid} -> ${ORC_PID}`);

      await startScheduler();
      await startWatchers();
      await startGateway();
      console.log("[orc] Scheduler + watchers + gateway active. Ctrl+C to stop.\n");

      const shutdown = async (signal: string) => {
        process.stdout.write(`\n[orc] ${signal} - shutting down...\n`);
        stopScheduler();
        await stopWatchers();
        await stopGateway();
        removePid();
        process.stdout.write("[orc] Stopped.\n");
        process.exit(0);
      };

      process.on("SIGINT", () => void shutdown("SIGINT"));
      process.on("SIGTERM", () => void shutdown("SIGTERM"));

      await new Promise(() => {});
    });

  cmd
    .command("stop")
    .description("Stop the running daemon")
    .action(() => {
      const daemonPid = readDaemonPid();
      if (!daemonPid) {
        console.log("No daemon running (no pid file at ~/.orc/daemon.pid).");
        return;
      }
      try {
        process.kill(daemonPid, "SIGTERM");
        console.log(`Sent SIGTERM to daemon (pid ${daemonPid}).`);
      } catch {
        console.error(`Could not signal pid ${daemonPid} - process may already be stopped.`);
        removePid();
      }
    });

  cmd
    .command("install")
    .description("Register orc daemon to start on login/boot and start it now")
    .action(async () => {
      ensureOrcHome();
      const os = platform();
      console.log("[orc] Installing daemon auto-start...");
      if (os === "win32") installWindows();
      else if (os === "darwin") installMacos();
      else installLinux();
      console.log(`\n  Log:     ${ORC_LOG}`);
      console.log(`  Config:  ~/.orc/config.json`);

      // macOS (launchctl load) and Linux (systemctl --now) already started it.
      // On Windows, start the daemon in a detached child process.
      if (os === "win32") {
        const bin = resolveOrcBin();
        const { spawn } = await import("node:child_process");
        const child = spawn(bin, ["daemon", "start"], {
          detached: true,
          stdio: "ignore",
          cwd: homedir(),
        });
        child.unref();
        console.log(`\n  Daemon started (pid ${child.pid}).`);
      }
      console.log("  Daemon will also start automatically on next login.");
    });

  cmd
    .command("uninstall")
    .description("Remove the auto-start registration created by 'orc daemon install'")
    .action(() => {
      const os = platform();
      console.log("[orc] Removing daemon auto-start...");
      if (os === "win32") uninstallWindows();
      else if (os === "darwin") uninstallMacos();
      else uninstallLinux();
    });

  cmd
    .command("status")
    .description("Show scheduler state and next run times for all active jobs")
    .action(async () => {
      const client = createOrcClient();
      const { data, error } = await client.jobs.list();
      if (error) return console.error("Error:", error);

      const scheduled = (data?.jobs ?? []).filter(
        (j) => j.enabled && (j.trigger_type === "cron" || j.trigger_type === "watch"),
      );

      if (scheduled.length === 0) {
        console.log("No scheduled jobs defined.");
        console.log("Create one with: orc job add <name> --trigger cron --cron '0 22 * * *' ...");
        return;
      }

      console.log("Scheduled jobs:\n");
      for (const j of scheduled) {
        const trigger = j.trigger_type === "cron" ? `cron(${j.cron_expr ?? "?"})` : j.trigger_type;
        const lastRun = j.last_run_at
          ? new Date(j.last_run_at).toISOString().slice(0, 19)
          : "never";
        const runs = `runs:${j.run_count}`;
        const enabled = j.enabled ? "●" : "○";
        console.log(
          `  ${enabled} ${j.name.padEnd(24)} ${trigger.padEnd(24)} last:${lastRun.padEnd(20)} ${runs}`,
        );
      }
    });

  return cmd;
}
