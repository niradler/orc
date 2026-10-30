import { type AgentSession, openAgentSession } from "@orc/agent-runtime";
import { type ChannelService, getChannelService } from "@orc/channels";
import { renderMessage } from "@orc/channels/render";
import { type ChannelInbound, type ChannelTarget, channelCommand } from "@orc/core/channels";
import { ChatSettingsSchema, chatSystemPrompt } from "@orc/core/chat";
import { loadConfig } from "@orc/core/config";
import { ConflictError, ValidationError } from "@orc/core/errors";
import { hostIsDirectory, resolveExecHost } from "@orc/core/exec-host";
import { getSqlite } from "@orc/db/client";
import { HumanRequestStore } from "@orc/db/human-requests";
import {
  channelDirectCommand,
  channelHelp,
  channelPrompt,
  ensureChannelSession,
} from "./channel-commands.js";
import { HumanRequestChannels } from "./human-requests.js";
import { getGatewayManager } from "./manager.js";
import { appendMessage, getOrCreateChat, updateGatewaySession } from "./store.js";
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
    if (
      !current ||
      current.chat_id !== chatId ||
      chatId !== target.chat_id ||
      current.thread_id !== target.thread_id ||
      !target.user_ids.every((user) => current.user_ids.includes(user))
    )
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
                {
                  type: "section",
                  text: {
                    type: opts?.parseMode === "markdown" ? "mrkdwn" : "plain_text",
                    text: String(
                      renderMessage("slack", {
                        text,
                        format: opts?.parseMode === "markdown" ? "markdown" : "plain",
                        links: [],
                      }).payloads[0]?.text ?? text,
                    ),
                  },
                },
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
        message: { text, format: opts?.parseMode === "markdown" ? "markdown" : "plain" },
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
  const activeTurns = new Map<
    string,
    { session: AgentSession; recordId: string; cancelled: boolean }
  >();
  const conversationKey = (message: ChannelInbound) =>
    JSON.stringify([message.connection, message.chat, message.thread ?? null, message.sender]);
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
  const dispatch: NonNullable<ChannelService["handler"]> = async (route, message, target) => {
    if (stopping || route.action.type !== "agent") return;
    const action = route.action;
    const defaults = ChatSettingsSchema.parse(loadConfig().preferences.chat ?? {});
    const defaultAgent = action.agent === "default" ? defaults.agent : action.agent;
    const defaultModel =
      action.model ?? (action.agent === "default" ? defaults.model || undefined : undefined);
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
      // Channel targets own authorization; bridge records only persist conversation state.
      authorized: false,
      mode: `agent:${defaultAgent}`,
      threadId: message.thread,
      scopeKey: chatKey,
    });
    const projectId = chat.project_id ?? action.project_id;
    const permittedProject = !target.project_ids.length || target.project_ids.includes(projectId);
    const project = permittedProject
      ? getSqlite()
          .query<{ name: string; scope: string | null; status: string }, [string]>(
            "SELECT name,scope,status FROM projects WHERE id=?",
          )
          .get(projectId)
      : null;
    const conversation = {
      chatKey: chat.id,
      projectId,
      cwd: project?.scope ?? "",
      mode: chat.mode,
      defaultProject: action.project_id,
      defaultAgent,
      defaultModel,
      allowedProjects: target.project_ids,
    };
    if (!chat.project_id && project)
      getSqlite()
        .query("UPDATE bridge_chats SET project_id=?,working_dir=? WHERE id=?")
        .run(projectId, project.scope, chat.id);
    const command = await channelDirectCommand({ ...conversation, text: message.text });
    if (command) {
      const text = command.text ?? "";
      const replyProject = command.projectId ?? (permittedProject ? projectId : undefined);
      if (command.buttons?.length) {
        await channelAdapter(service, message.connection, {
          ...target,
          user_ids: [message.sender],
        }).sendWithButtons(message.chat, text, command.buttons, {
          projectId: replyProject,
          threadId: message.thread,
        });
      } else await reply(message, target, text, "plain", replyProject);
      await appendMessage({
        chatKey: chat.id,
        direction: "in",
        role: "user",
        text: message.text,
        platformMessageId: message.message_id,
        threadId: message.thread,
      });
      await appendMessage({
        chatKey: chat.id,
        direction: "out",
        role: "system",
        text,
        threadId: message.thread,
      });
      return;
    }
    if (!permittedProject || !project?.scope || project.status !== "active")
      throw new ValidationError(
        "Select an allowed active project with a working folder using /project.",
      );
    if (!(await hostIsDirectory(resolveExecHost(), project.scope)))
      throw new ValidationError("Project folder is unavailable on the execution host");
    const record = await ensureChannelSession(conversation);
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
        record.backend,
        {
          cwd: project.scope,
          model: record.model ?? undefined,
          interactive: true,
          autoApprove: false,
          permissionMode:
            record.permission_mode === "plan" || record.permission_mode === "acceptEdits"
              ? record.permission_mode
              : "default",
          humanRequestContext: {
            projectId,
            notify: [provider],
            channel: {
              connection: message.connection,
              target: target.id,
              chat_id: message.chat,
              sender_id: message.sender,
              ...(message.thread ? { thread_id: message.thread } : {}),
            },
          },
          ...(action.profile && record.backend === defaultAgent
            ? { agentProfile: action.profile }
            : {}),
          systemPromptAppend: chatSystemPrompt(defaults.system),
          orcMcp: true,
          orcMcpMode: "meta",
          orcMcpProject: project.name,
        },
        record.runtime_session_id ?? undefined,
      );
      sessions.add(session);
      const turn = { session, recordId: record.id, cancelled: false };
      activeTurns.set(conversationKey(message), turn);
      const active = session;
      timer = setTimeout(
        () => {
          void active.close();
        },
        60 * 60 * 1000,
      );
      timer.unref();
      await session.send(channelPrompt(service.connection(message.connection), message.text));
      let output = "";
      let runtimeId: string | undefined;
      for await (const event of session.events()) {
        if (turn.cancelled) break;
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
      if (turn.cancelled) return;
      runtimeId ??= session.getRuntimeSessionId?.();
      if (output) {
        await reply(message, target, output, "markdown", projectId);
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
      if (activeTurns.get(conversationKey(message))?.cancelled) return;
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
        if (activeTurns.get(conversationKey(message))?.session === session)
          activeTurns.delete(conversationKey(message));
        sessions.delete(session);
        await session.close();
      }
    }
  };
  service.handler = async (route, message, target) => {
    try {
      await dispatch(route, message, target);
    } catch {
      await reply(
        message,
        target,
        "This channel could not handle the message. Check the selected project's working directory, agent configuration and channel status in ORC.",
        "plain",
      );
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
    const command = channelCommand(text);
    if (command?.name === "help" || command?.name === "start") {
      await reply(message, target, channelHelp(service.connection(message.connection)), "markdown");
      return true;
    }
    if (
      command?.name === "stop" ||
      (command?.name === "session" &&
        command.args === "stop" &&
        activeTurns.has(conversationKey(message)))
    ) {
      service.cancelPending(message);
      const turn = activeTurns.get(conversationKey(message));
      if (turn) {
        turn.cancelled = true;
        await updateGatewaySession(turn.recordId, { status: "stopped" });
        await turn.session.close();
      }
      await reply(
        message,
        target,
        turn
          ? "Stopped the current turn and cleared queued messages. Use /session new for a new conversation."
          : "No agent turn is running. Use /session new for a new conversation.",
        "plain",
      );
      return true;
    }
    if (message.kind === "action" && text !== message.text) {
      const answer = human.reply(
        {
          ...incoming(service, message),
          text,
          connectionId: `${message.connection}:${target.id}`,
        },
        target,
      );
      if (answer) await reply(message, target, answer, "plain");
      else {
        message.text = text;
        message.kind = "message";
      }
      return !!answer;
    }
    const inbound = {
      ...incoming(service, message),
      text,
      connectionId: `${message.connection}:${target.id}`,
    };
    const answer =
      human.reply(inbound, target) ??
      (target.attention ? human.replyToPendingQuestion(inbound, target) : null);
    if (!answer) return false;
    await reply(message, target, answer, "plain");
    return true;
  };
  service.unmatched = async (message, target) => {
    await reply(
      message,
      target,
      "No inbound route matches this message. Choose a project and agent in Settings → Channels → Inbound routing. Use /help for channel commands.",
      "plain",
    );
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
    service.unmatched = undefined;
    service.beforeConnect = undefined;
    await Promise.allSettled([...sessions].map((s) => s.close()));
    await service.stop();
  };
}
