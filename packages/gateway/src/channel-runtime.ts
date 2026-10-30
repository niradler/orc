import { type AgentSession, openAgentSession } from "@orc/agent-runtime";
import { type ChannelService, getChannelService } from "@orc/channels";
import type { ChannelInbound, ChannelTarget } from "@orc/core/channels";
import { ConflictError, ValidationError } from "@orc/core/errors";
import { hostIsDirectory, resolveExecHost } from "@orc/core/exec-host";
import { getSqlite } from "@orc/db/client";
import { HumanRequestStore } from "@orc/db/human-requests";
import { HumanRequestChannels } from "./human-requests.js";
import { getGatewayManager } from "./manager.js";
import {
  appendMessage,
  createGatewaySession,
  getActiveGatewaySession,
  getOrCreateChat,
  updateGatewaySession,
} from "./store.js";
import type { GatewayAdapter, IncomingMessage, SendOpts, SupportsInlineButtons } from "./types.js";

function incoming(service: ChannelService, message: ChannelInbound): IncomingMessage {
  return {
    connectionId: message.connection,
    platform: service.connection(message.connection).provider,
    chatId: message.chat,
    userId: message.sender,
    text: message.text,
    platformMessageId: message.message_id,
    threadId: message.thread,
  };
}
function channelAdapter(
  service: ChannelService,
  connection: string,
  target: ChannelTarget,
): GatewayAdapter & SupportsInlineButtons {
  const bindDestination = (chatId: string) => {
    const current = service.connection(connection).targets.find((t) => t.id === target.id);
    if (!current || current.chat_id !== chatId || chatId !== target.chat_id)
      throw new ConflictError("Notification destination changed");
  };
  return {
    platform: service.connection(connection).provider,
    start: async () => {},
    stop: async () => {},
    async send(_chatId: string, text: string, opts?: SendOpts) {
      bindDestination(_chatId);
      const receipt = await service.send({
        connection,
        target: target.id,
        project_id: opts?.projectId,
        message: { text, format: opts?.parseMode === "markdown" ? "markdown" : "plain" },
        ...(opts?.threadId ? { thread_id: opts.threadId } : {}),
        ...(opts?.parseMode === "html" ? { overrides: { text, parse_mode: "HTML" } } : {}),
      });
      if (receipt.status !== "accepted")
        throw new ConflictError(receipt.error ?? "Channel delivery not confirmed");
      return receipt.id;
    },
    async sendWithButtons(chatId, text, buttons, opts) {
      bindDestination(chatId);
      const provider = service.connection(connection).provider;
      const mapped = buttons.map((row) =>
        row.map((button) => {
          const requestId = button.value.match(/^\/attention (\S+)/)?.[1];
          const request = requestId ? new HumanRequestStore(getSqlite()).get(requestId) : null;
          const users = request?.input.origin.channel
            ? [request.input.origin.channel.sender_id]
            : target.user_ids;
          return {
            label: button.label,
            value: service.store.action(
              connection,
              target.id,
              chatId,
              opts?.threadId,
              users,
              button.value,
            ),
          };
        }),
      );
      const overrides =
        provider === "telegram"
          ? {
              reply_markup: {
                inline_keyboard: mapped.map((row) =>
                  row.map((b) => ({ text: b.label, callback_data: b.value })),
                ),
              },
            }
          : {
              blocks: [
                { type: "section", text: { type: "plain_text", text } },
                ...mapped.map((row, i) => ({
                  type: "actions",
                  block_id: `attention-${i}`,
                  elements: row.map((b) => ({
                    type: "button",
                    action_id: b.value,
                    text: { type: "plain_text", text: b.label },
                    value: b.value,
                  })),
                })),
              ],
            };
      const receipt = await service.send({
        connection,
        target: target.id,
        project_id: opts?.projectId,
        message: { text, format: "plain" },
        overrides,
        ...(opts?.threadId ? { thread_id: opts.threadId } : {}),
      });
      if (receipt.status !== "accepted")
        throw new ConflictError(receipt.error ?? "Channel delivery not confirmed");
      return receipt.id;
    },
  };
}

export async function startChannelRuntime(
  service = getChannelService(),
): Promise<() => Promise<void>> {
  const human = new HumanRequestChannels(new HumanRequestStore(getSqlite()));
  const sessions = new Set<AgentSession>();
  let stopping = false;
  let notifying = false;
  const reply = async (
    message: ChannelInbound,
    target: ChannelTarget,
    text: string,
    format = "markdown",
    projectId?: string,
  ) => {
    if (stopping) return;
    const current = service.connection(message.connection);
    const recipient = current.targets.find(
      (t) =>
        t.id === target.id &&
        t.chat_id === message.chat &&
        (!t.thread_id || t.thread_id === message.thread) &&
        t.user_ids.includes(message.sender),
    );
    if (
      !current.enabled ||
      !recipient?.outbound ||
      (projectId && recipient.project_ids.length && !recipient.project_ids.includes(projectId))
    )
      return;
    const result = await service.send({
      connection: message.connection,
      target: target.id,
      message: { text, format },
      ...(projectId ? { project_id: projectId } : {}),
      ...(message.thread ? { thread_id: message.thread } : {}),
    });
    if (result.status !== "accepted")
      throw new ConflictError(result.error ?? "Channel delivery not confirmed");
  };
  service.handler = async (route, message, target) => {
    if (stopping || route.action.type !== "agent") return;
    const action = route.action;
    const project = getSqlite()
      .query<{ scope: string | null; status: string }, [string]>(
        "SELECT scope,status FROM projects WHERE id=?",
      )
      .get(action.project_id);
    if (!project?.scope || project.status !== "active")
      throw new ValidationError("Route requires an active project with a working directory");
    if (!(await hostIsDirectory(resolveExecHost(), project.scope)))
      throw new ValidationError("Route project directory is unavailable on the execution host");
    const provider = service.connection(message.connection).provider;
    const chatKey = JSON.stringify([
      "channel",
      message.connection,
      message.chat,
      message.thread ?? null,
      message.sender,
      route.id,
      action,
    ]);
    const chat = await getOrCreateChat({
      platform: provider,
      chatId: message.chat,
      // Channel targets own authorization; this is not a legacy command-enabled chat.
      authorized: false,
      mode: `agent:${action.agent}`,
      threadId: message.thread,
      scopeKey: chatKey,
    });
    let record = await getActiveGatewaySession(chat.id);
    if (!record || record.status === "stopped")
      record = await createGatewaySession({
        chatKey: chat.id,
        backend: action.agent,
        cwd: project.scope,
        mode: `agent:${action.agent}`,
        title: `${service.connection(message.connection).name} · ${route.name}`,
      });
    getSqlite()
      .query("UPDATE gateway_sessions SET project_id=? WHERE id=?")
      .run(action.project_id, record.id);
    await appendMessage({
      chatKey: chat.id,
      direction: "in",
      role: "user",
      text: message.text,
      platformMessageId: message.message_id,
      threadId: message.thread,
      gatewaySessionId: record.id,
    });
    let session: AgentSession | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await updateGatewaySession(record.id, { status: "running", last_activity_at: new Date() });
      session = await openAgentSession(
        action.agent,
        {
          cwd: project.scope,
          interactive: true,
          autoApprove: false,
          humanRequestContext: {
            projectId: action.project_id,
            notify: [provider],
            channel: {
              connection: message.connection,
              target: target.id,
              chat_id: message.chat,
              sender_id: message.sender,
              ...(message.thread ? { thread_id: message.thread } : {}),
            },
          },
          ...(action.profile ? { agentProfile: action.profile } : {}),
          orcMcp: true,
        },
        record.runtime_session_id ?? undefined,
      );
      sessions.add(session);
      const active = session;
      timer = setTimeout(
        () => {
          void active.close();
        },
        60 * 60 * 1000,
      );
      timer.unref();
      await session.send(message.text);
      let output = "";
      let runtimeId: string | undefined;
      for await (const event of session.events()) {
        if (event.type === "text") output += event.data;
        if (output.length > 100000)
          throw new ValidationError(
            "Agent output exceeds the channel message limit; inspect the session in ORC",
          );
        if (event.type === "error")
          throw new Error("Agent turn failed; inspect the originating session in ORC");
        if (event.type === "question_request" && event.data.questions.some((q) => q.isSecret))
          throw new Error("Secret input must be supplied through the originating agent interface");
        if (event.type === "result") {
          runtimeId = event.data.runtimeSessionId;
          break;
        }
      }
      runtimeId ??= session.getRuntimeSessionId?.();
      if (output) {
        await reply(message, target, output, "markdown", action.project_id);
        await appendMessage({
          chatKey: chat.id,
          direction: "out",
          role: "assistant",
          text: output,
          threadId: message.thread,
          gatewaySessionId: record.id,
        });
      }
      await updateGatewaySession(record.id, {
        status: "idle",
        runtime_session_id: runtimeId,
        last_activity_at: new Date(),
        last_error: null,
      });
    } catch {
      await updateGatewaySession(record.id, {
        status: "error",
        last_error: "Channel agent turn failed; inspect this session",
        last_activity_at: new Date(),
      });
      await reply(
        message,
        target,
        "The agent could not complete this turn. Check the session and channel status in ORC.",
        "plain",
      );
    } finally {
      if (timer) clearTimeout(timer);
      if (session) {
        sessions.delete(session);
        await session.close();
      }
    }
  };
  const notify = async () => {
    if (notifying || stopping) return;
    notifying = true;
    try {
      const adapters = new Map<string, GatewayAdapter>();
      const targets: Array<{
        platform: string;
        provider: string;
        chat_id: string;
        project_id: string | null;
        thread_id: string | null;
      }> = [];
      const requests = new HumanRequestStore(getSqlite()).list();
      const projects = new Set(requests.map((r) => r.input.project_id));
      const ready = new Set(
        service
          .list()
          .filter((c) => c.status === "ready")
          .map((c) => c.id),
      );
      for (const c of service.connections().filter((c) => c.enabled && ready.has(c.id)))
        for (const t of c.targets.filter(
          (t) => t.attention && t.inbound && t.outbound && t.user_ids.length,
        )) {
          const destination = `${c.id}:${t.id}`;
          adapters.set(destination, channelAdapter(service, c.id, t));
          for (const project of projects)
            if (!t.project_ids.length || (project && t.project_ids.includes(project)))
              targets.push({
                platform: destination,
                provider: c.provider,
                chat_id: t.chat_id,
                project_id: project,
                thread_id: t.thread_id ?? null,
              });
          for (const request of requests) {
            const source = request.input.origin.channel;
            if (
              !source ||
              source.connection !== c.id ||
              source.target !== t.id ||
              source.chat_id !== t.chat_id ||
              !t.user_ids.includes(source.sender_id) ||
              (t.thread_id && t.thread_id !== source.thread_id) ||
              (t.project_ids.length &&
                (!request.input.project_id || !t.project_ids.includes(request.input.project_id)))
            )
              continue;
            targets.push({
              platform: destination,
              provider: c.provider,
              chat_id: source.chat_id,
              project_id: request.input.project_id,
              thread_id: source.thread_id ?? null,
            });
          }
        }
      await human.notify(adapters, targets);
    } finally {
      notifying = false;
    }
  };
  // Attention receipts are bound to connection + target as well as chat/thread.
  service.control = async (message, target) => {
    let text = message.text;
    if (message.kind === "action" && text.startsWith("orc_action:")) {
      const value = service.store.consumeAction(
        text.slice(11),
        message.connection,
        target.id,
        message.chat,
        message.thread,
        message.sender,
      );
      if (!value) {
        await reply(
          message,
          target,
          "This button expired or was already used. Open Attention needed in ORC.",
          "plain",
        );
        return true;
      }
      text = value;
    }
    const answer = human.reply({
      ...incoming(service, message),
      text,
      connectionId: `${message.connection}:${target.id}`,
    });
    if (!answer) return false;
    await reply(message, target, answer, "plain");
    return true;
  };
  service.beforeConnect = async () => {
    await getGatewayManager()?.releaseManagedAccounts();
  };
  await service.start();
  const timer = setInterval(() => {
    void notify().catch(() => {});
  }, 2000);
  timer.unref();
  return async () => {
    stopping = true;
    clearInterval(timer);
    service.handler = undefined;
    service.control = undefined;
    service.beforeConnect = undefined;
    await Promise.allSettled([...sessions].map((s) => s.close()));
    await service.stop();
  };
}
