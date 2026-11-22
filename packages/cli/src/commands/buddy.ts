import { runBridge } from "@orc/buddy/bridge";
import { createBuddyApi } from "@orc/buddy/orc";
import { BUDDY_PROTOCOL_VERSION, BuddyHostCommandSchema } from "@orc/buddy/protocol";
import { listSerialPorts, openSerialTransport } from "@orc/buddy/transports/serial";
import { createSimulatorTransport } from "@orc/buddy/transports/simulate";
import { Command } from "commander";
import { isJson, jsonOut } from "../output.js";

type BuddyOpts = {
  port?: string;
  baud?: string;
  simulate?: boolean;
  url?: string;
  token?: string;
  project?: string;
  listPorts?: boolean;
};

export function buddyCommand(): Command {
  const command = new Command("buddy").description(
    "Desktop buddy: live ORC activity on an ESP32 display (or a terminal simulator)",
  );

  command
    .option("--port <path>", "Serial device path (COM5, /dev/ttyUSB0, …)")
    .option("--baud <n>", "Serial baud rate", "115200")
    .option("--simulate", "Render the buddy in the terminal instead of a device")
    .option("--url <url>", "ORC API base URL (default: config)")
    .option("--token <token>", "API access token (default: config secret)")
    .option("--project <id>", "Only show this project's sessions and alerts")
    .option("--list-ports", "List serial ports and exit")
    .action(async (opts: BuddyOpts) => {
      if (opts.listPorts) {
        const ports = await listSerialPorts();
        if (isJson()) return jsonOut(ports);
        if (!ports.length) console.log("No serial ports found.");
        for (const port of ports)
          console.log(`${port.path.padEnd(10)} ${port.manufacturer ?? ""}`.trimEnd());
        return;
      }
      if (!opts.port && !opts.simulate) {
        console.error(
          "Pick a device with --port <path>, or use --simulate. --list-ports shows yours.",
        );
        process.exitCode = 1;
        return;
      }
      const api = createBuddyApi({ baseUrl: opts.url, token: opts.token });
      const health = await api.client.health.check();
      if (health.error) {
        console.error(`API unreachable at ${api.baseUrl} - is ORC running?`);
        process.exitCode = 1;
        return;
      }
      const transport = opts.simulate
        ? createSimulatorTransport()
        : await openSerialTransport(opts.port as string, Number(opts.baud ?? 115200));
      const bridge = await runBridge({
        api,
        transport,
        projectId: opts.project ?? null,
        log: (message) => console.error(`[buddy] ${message}`),
      });
      process.on("SIGINT", () => void bridge.stop());
      await bridge.done;
    });

  command
    .command("token")
    .description("Mint an access token for the device's HTTP mode (needs api.secret)")
    .option("--days <n>", "Token lifetime in days", "30")
    .option("--url <url>", "ORC API base URL (default: config)")
    .action(async (opts: { days: string; url?: string }) => {
      const api = createBuddyApi({ baseUrl: opts.url });
      const { token, expires_at: expiresAt } = await api.createToken(Number(opts.days));
      if (isJson()) return jsonOut({ token, expires_at: expiresAt });
      console.log(`Device token (expires ${new Date(expiresAt * 1000).toISOString()}):`);
      console.log(token);
      console.log(
        "\nProvision it over serial: orc buddy config --port <path> --url <api-url> --token <token>",
      );
    });

  command
    .command("config")
    .description("Push WiFi/API settings to a device over serial (stored in its NVS)")
    .requiredOption("--port <path>", "Serial device path")
    .option("--baud <n>", "Serial baud rate", "115200")
    .option("--url <url>", "ORC API base URL the device should use on WiFi")
    .option("--token <token>", "Device access token (orc buddy token)")
    .option("--ssid <ssid>", "WiFi network name")
    .option("--pass <pass>", "WiFi password")
    .option("--name <name>", "Device display name")
    .action(
      async (opts: {
        port: string;
        baud: string;
        url?: string;
        token?: string;
        ssid?: string;
        pass?: string;
        name?: string;
      }) => {
        const config = {
          cmd: "config" as const,
          ...(opts.url ? { url: opts.url } : {}),
          ...(opts.token ? { token: opts.token } : {}),
          ...(opts.ssid ? { ssid: opts.ssid } : {}),
          ...(opts.pass !== undefined ? { pass: opts.pass } : {}),
          ...(opts.name ? { name: opts.name } : {}),
        };
        if (Object.keys(config).length === 1) {
          console.error("Nothing to set: pass --url/--token/--ssid/--pass/--name.");
          process.exitCode = 1;
          return;
        }
        const validated = BuddyHostCommandSchema.safeParse(config);
        if (!validated.success) {
          console.error(
            `Invalid config: ${validated.error.issues[0]?.message ?? "check the flags"}`,
          );
          process.exitCode = 1;
          return;
        }
        const transport = await openSerialTransport(opts.port, Number(opts.baud));
        const result = await new Promise<{ ok: boolean; error?: string | undefined }>((resolve) => {
          const timer = setTimeout(() => {
            resolve({
              ok: false,
              error: "Device did not ack within 5s (is the buddy firmware running?)",
            });
          }, 5000);
          transport.onMessage((value) => {
            const ack = value as { ack?: string; ok?: boolean; error?: string };
            if (ack.ack === "config") {
              clearTimeout(timer);
              resolve({ ok: ack.ok === true, error: ack.error });
            }
          });
          void transport.send(`${JSON.stringify(validated.data)}\n`);
        });
        await transport.close();
        if (isJson()) return jsonOut(result);
        if (result.ok) console.log("Device configured.");
        else {
          console.error(`Config failed: ${result.error}`);
          process.exitCode = 1;
        }
      },
    );

  command.addHelpText(
    "after",
    `\nWire protocol v${BUDDY_PROTOCOL_VERSION}: https://niradler.github.io/orc/docs/buddy\nQuick start without hardware: orc buddy --simulate`,
  );

  return command;
}
