import { createOrcClient } from "@orc/sdk/client";
import { Command } from "commander";

function fail(error: { error: string }): never {
  console.error(`Error: ${error.error}`);
  process.exit(1);
}

export function channelsCommand() {
  const cmd = new Command("channels").description(
    "Inspect channel connections, send messages and test inbound rules",
  );

  cmd
    .command("list")
    .description("Show connections with status, destinations and rules")
    .action(async () => {
      const { data, error } = await createOrcClient().channels.list();
      if (error) fail(error);
      for (const c of data)
        console.log(
          `${c.id}\t${c.provider}\t${c.status}${c.error ? ` (${c.error})` : ""}\t${c.targets.length} destinations\t${c.routes.length} rules`,
        );
    });

  cmd
    .command("send")
    .description("Send a message to a configured destination")
    .requiredOption("--connection <id>", "Connection ID")
    .requiredOption("--target <id>", "Destination ID")
    .requiredOption("--text <text>", "Message text (Markdown)")
    .option("--thread <id>", "Telegram topic or Slack thread timestamp")
    .action(async (opts) => {
      const { data, error } = await createOrcClient().channels.send({
        connection: opts.connection,
        target: opts.target,
        message: { text: opts.text, format: "markdown", links: [] },
        ...(opts.thread ? { thread_id: opts.thread } : {}),
      });
      if (error) fail(error);
      console.log(`${data.status} ${data.id}`);
      if (data.status !== "accepted") process.exit(1);
    });

  cmd
    .command("test")
    .description("Show which rule an inbound message would match, without running it")
    .requiredOption("--connection <id>", "Connection ID")
    .requiredOption("--sender <id>", "Provider user ID")
    .requiredOption("--chat <id>", "Provider chat ID")
    .requiredOption("--text <text>", "Message text")
    .option("--thread <id>", "Thread ID")
    .option("--direct", "Message is a private message", false)
    .option("--mention", "Message mentions the bot", false)
    .option("--followup", "Message continues an answered thread", false)
    .action(async (opts) => {
      const { data, error } = await createOrcClient().channels.routeTest(opts.connection, {
        sender: opts.sender,
        chat: opts.chat,
        text: opts.text,
        is_direct: opts.direct,
        is_mention: opts.mention,
        is_followup: opts.followup,
        ...(opts.thread ? { thread: opts.thread } : {}),
      });
      if (error) fail(error);
      console.log(JSON.stringify(data, null, 2));
    });

  return cmd;
}
