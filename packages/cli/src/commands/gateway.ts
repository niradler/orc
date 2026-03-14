import { createOrcClient } from "@orc/sdk/client";
import { Command } from "commander";

export function gatewayCommand() {
  const cmd = new Command("gateway").description("Inspect and send channel gateway messages");

  cmd
    .command("status")
    .description("Show enabled adapters and active sessions")
    .action(async () => {
      const client = createOrcClient();
      const { data, error } = await client.gateway.status();
      if (error) {
        console.error(`Error: ${error.error}`);
        process.exit(1);
      }
      console.log(data.status);
    });

  cmd
    .command("send")
    .description("Send a message to a configured Telegram or Slack chat")
    .requiredOption("--platform <platform>", "telegram or slack")
    .requiredOption("--chat <id>", "Platform chat/channel ID")
    .requiredOption("--text <text>", "Message text")
    .option("--thread <id>", "Optional Telegram thread or Slack thread timestamp")
    .action(async (opts) => {
      const client = createOrcClient();
      const { error } = await client.gateway.send({
        platform: opts.platform,
        chat_id: opts.chat,
        text: opts.text,
        thread_id: opts.thread,
      });
      if (error) {
        console.error(`Error: ${error.error}`);
        process.exit(1);
      }
      console.log(`Sent message to ${opts.platform}:${opts.chat}`);
    });

  return cmd;
}
