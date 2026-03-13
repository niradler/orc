import { getGatewayStatus, sendGatewayMessage } from "@orc/gateway";
import { Command } from "commander";

export function gatewayCommand() {
  const cmd = new Command("gateway").description("Inspect and send channel gateway messages");

  cmd
    .command("status")
    .description("Show enabled adapters and active sessions")
    .action(async () => {
      console.log(await getGatewayStatus());
    });

  cmd
    .command("send")
    .description("Send a message to a configured Telegram or Slack chat")
    .requiredOption("--platform <platform>", "telegram or slack")
    .requiredOption("--chat <id>", "Platform chat/channel ID")
    .requiredOption("--text <text>", "Message text")
    .option("--thread <id>", "Optional Telegram thread or Slack thread timestamp")
    .action(async (opts) => {
      await sendGatewayMessage(opts.platform, opts.chat, opts.text, { threadId: opts.thread });
      console.log(`Sent message to ${opts.platform}:${opts.chat}`);
    });

  return cmd;
}
