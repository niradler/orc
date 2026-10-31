import { discoverAgentModels, listRegisteredBackends } from "@orc/agent-runtime";
import type { ChannelConnection } from "@orc/core/channels";
import { ChannelBuiltinCommands, channelCommand, channelCommands } from "@orc/core/channels";
import { hostIsDirectory, resolveExecHost } from "@orc/core/exec-host";
import type { GatewayMode } from "@orc/core/types";
import { getSqlite } from "@orc/db/client";
import {
  createGatewaySession,
  getActiveGatewaySession,
  listGatewaySessions,
  setActiveGatewaySession,
  updateChatMode,
  updateChatProject,
  updateChatWorkingDir,
  updateGatewaySession,
} from "./store.js";
import type { DirectCommandResult } from "./types.js";

export function channelControls(): NonNullable<DirectCommandResult["buttons"]> {
  return [
    [
      { label: "New session", value: "/session_new" },
      { label: "Sessions", value: "/session_list" },
    ],
    [
      { label: "Project", value: "/project" },
      { label: "Agent", value: "/agent" },
      { label: "Model", value: "/model" },
    ],
    [
      { label: "Status", value: "/status" },
      { label: "Stop", value: "/stop" },
    ],
  ];
}

function picker(
  command: string,
  items: Array<{ label: string; value: string }>,
  page: number,
): NonNullable<DirectCommandResult["buttons"]> {
  const size = 8;
  const offset = Math.min(page * size, Math.max(0, Math.ceil(items.length / size) - 1) * size);
  const rows = items.slice(offset, offset + size).map((item) => [item]);
  const navigation = [];
  if (offset > 0)
    navigation.push({ label: "‹ Previous", value: `/${command} page ${offset / size - 1}` });
  if (offset + size < items.length)
    navigation.push({ label: "Next ›", value: `/${command} page ${offset / size + 1}` });
  if (navigation.length) rows.push(navigation);
  rows.push([{ label: "Chat controls", value: "/status" }]);
  return rows;
}

export type ChannelConversation = {
  chatKey: string;
  projectId: string;
  cwd: string;
  mode: GatewayMode;
  defaultProject: string;
  defaultAgent: string;
  defaultModel?: string | undefined;
  allowedProjects: string[];
};
export function channelHelp(connection: ChannelConnection): string {
  return [
    "**ORC chat controls**",
    ...ChannelBuiltinCommands.map((c) => `/${c.command} — ${c.description}`),
    ...channelCommands(connection.config).map((c) => `/${c.command} — ${c.description}`),
    "",
    "Send a message to the active agent. Follow-ups continue the selected session.",
    "Use the buttons to choose a project, agent, model or session, and restore the agent or model default.",
  ].join("\n");
}
export async function ensureChannelSession(input: ChannelConversation) {
  const active = await getActiveGatewaySession(input.chatKey);
  const backend = input.mode.replace(/^agent:/, "");
  if (
    active &&
    active.status !== "stopped" &&
    active.backend === backend &&
    active.project_id === input.projectId
  )
    return active;
  const session = await createGatewaySession({
    chatKey: input.chatKey,
    backend,
    cwd: input.cwd,
    mode: input.mode,
    title: `${backend} conversation`,
  });
  await updateGatewaySession(session.id, {
    project_id: input.projectId,
    model: backend === input.defaultAgent ? (input.defaultModel ?? null) : null,
  });
  return (await getActiveGatewaySession(input.chatKey)) ?? session;
}
export async function channelDirectCommand(
  input: ChannelConversation & { text: string },
): Promise<DirectCommandResult | null> {
  const command = channelCommand(input.text);
  if (!command) return null;
  const active = await getActiveGatewaySession(input.chatKey);
  const current = active?.project_id === input.projectId ? active : null;
  const agent = input.mode.replace(/^agent:/, "");
  const pageMatch = command.args.match(/^page (\d{1,6})$/);
  const page = Number(pageMatch?.[1] ?? 0);
  if (command.name === "status")
    return {
      text: `Project: ${input.projectId}\nFolder: ${input.cwd}\nAgent: ${agent}\nModel: ${current?.model ?? (agent === input.defaultAgent ? input.defaultModel : undefined) ?? "provider default"}\nSession: ${current ? `${current.id} (${current.status})` : "new conversation"}`,
      buttons: channelControls(),
    };
  if (command.name === "project" || command.name === "projects") {
    const projects = getSqlite()
      .query<{ id: string; name: string; scope: string | null }, []>(
        "SELECT id,name,scope FROM projects WHERE status='active' ORDER BY name LIMIT 1000",
      )
      .all()
      .filter((p) => !input.allowedProjects.length || input.allowedProjects.includes(p.id));
    if (!command.args || pageMatch)
      return {
        text: `Current project: ${projects.find((p) => p.id === input.projectId)?.name ?? input.projectId}\nChoose a project; its folder becomes the agent working directory.`,
        buttons: picker(
          "project",
          projects.map((p) => ({
            label: `${p.id === input.projectId ? "✓ " : ""}${p.name}`,
            value: `/project ${p.id}`,
          })),
          page,
        ),
      };
    const requested = command.args === "default" ? input.defaultProject : command.args;
    const selected = projects.find(
      (p) => p.id === requested || p.name.toLowerCase() === requested.toLowerCase(),
    );
    if (!selected)
      return {
        text: "Project is unavailable or not allowed for this recipient. Use /project to choose an allowed project.",
      };
    if (!selected.scope || !(await hostIsDirectory(resolveExecHost(), selected.scope)))
      return {
        text: "That project's working folder is unavailable on the execution host. Set its folder in ORC first.",
      };
    await updateChatProject(input.chatKey, selected.id);
    await updateChatWorkingDir(input.chatKey, selected.scope);
    const previous = (await listGatewaySessions(input.chatKey, selected.id)).find(
      (s) => s.project_id === selected.id && s.backend === agent && s.status !== "stopped",
    );
    await setActiveGatewaySession(input.chatKey, previous?.id ?? null);
    return {
      text: `Project: ${selected.name}\nAgent working folder: ${selected.scope}\n${previous ? "Resuming this project's conversation." : "The next message starts a conversation in this project."}`,
      projectId: selected.id,
      buttons: channelControls(),
    };
  }
  if (command.name === "agent") {
    const agents = listRegisteredBackends();
    if (!command.args || pageMatch)
      return {
        text: `Current agent: ${agent}\nDefault: ${input.defaultAgent}`,
        buttons: picker(
          "agent",
          [
            { label: "Default agent", value: "/agent default" },
            ...agents.map((name) => ({
              label: `${name === agent ? "✓ " : ""}${name}`,
              value: `/agent ${name}`,
            })),
          ],
          page,
        ),
      };
    const selected = command.args === "default" ? input.defaultAgent : command.args;
    if (!agents.includes(selected))
      return { text: `Unknown agent. Available: ${agents.join(", ")}` };
    const mode: GatewayMode = `agent:${selected}`;
    await updateChatMode(input.chatKey, mode);
    const previous = (await listGatewaySessions(input.chatKey, input.projectId)).find(
      (session) =>
        session.project_id === input.projectId &&
        session.backend === selected &&
        session.status !== "stopped",
    );
    if (previous) await setActiveGatewaySession(input.chatKey, previous.id);
    else await ensureChannelSession({ ...input, mode });
    return {
      text: `Agent: ${selected}. The next message uses its selected conversation.`,
      buttons: channelControls(),
    };
  }
  if (command.name === "model") {
    const session = await ensureChannelSession(input);
    if (!command.args || command.args === "list" || pageMatch) {
      const models = await discoverAgentModels(
        agent.replace(/-cli$/, ""),
        resolveExecHost(),
        input.cwd,
      ).catch(() => []);
      return {
        text: `Current model: ${session.model ?? (agent === input.defaultAgent ? input.defaultModel : undefined) ?? "provider default"}\nChoose a model below or tap Default model.`,
        buttons: picker(
          "model",
          [
            { label: "Default model", value: "/model default" },
            ...models.map((m) => ({
              label: `${m.id === session.model ? "✓ " : ""}${m.label}`,
              value: `/model ${m.id}`,
            })),
          ],
          page,
        ),
      };
    }
    if (command.args !== "default" && !/^[a-z0-9][a-z0-9._:/@+-]{0,199}$/i.test(command.args))
      return { text: "Use /model to choose a model." };
    const model =
      command.args === "default"
        ? agent === input.defaultAgent
          ? (input.defaultModel ?? null)
          : null
        : command.args;
    await updateGatewaySession(session.id, { model });
    return {
      text: `Model: ${model ?? "provider default"}. It takes effect on the next message.`,
      buttons: channelControls(),
    };
  }
  if (command.name === "session" || command.name === "sessions") {
    const [operation = "list", argument = ""] =
      command.name === "sessions" ? ["list"] : (command.args || "list").split(/\s+/);
    const sessions = (await listGatewaySessions(input.chatKey, input.projectId)).filter(
      (s) => s.project_id === input.projectId,
    );
    if (operation === "list" || pageMatch)
      return {
        text: sessions.length
          ? "Choose a session below. ✓ marks the active session.\n" +
            sessions
              .filter((s) => s.status !== "stopped")
              .slice(page * 8, page * 8 + 8)
              .map(
                (s, i) =>
                  `${i + 1}. ${s.id === current?.id ? "▶ " : ""}${s.id} · ${s.backend} · ${s.model ?? "default model"} · ${s.status}`,
              )
              .join("\n")
          : "No sessions in this project yet. Send a message or tap New conversation.",
        buttons: [
          [{ label: "New conversation", value: "/session_new" }],
          ...picker(
            "session",
            sessions
              .filter((s) => s.status !== "stopped")
              .map((s) => ({
                label: `${s.id === current?.id ? "✓ " : ""}${s.backend} · ${s.id.slice(-6)}`,
                value: `/session switch ${s.id}`,
              })),
            page,
          ),
        ],
      };
    if (operation === "new") {
      const session = await createGatewaySession({
        chatKey: input.chatKey,
        backend: agent,
        cwd: input.cwd,
        mode: input.mode,
        title: `${agent} conversation`,
      });
      await updateGatewaySession(session.id, {
        project_id: input.projectId,
        model:
          current?.model ?? (agent === input.defaultAgent ? (input.defaultModel ?? null) : null),
      });
      return {
        text: `Created and activated ${agent} session ${session.id}.`,
        buttons: channelControls(),
      };
    }
    if (operation === "switch") {
      const selected = /^\d+$/.test(argument)
        ? sessions[Number(argument) - 1]
        : sessions.find((s) => s.id === argument || s.id.endsWith(argument));
      if (!selected || selected.status === "stopped")
        return { text: "Session is unavailable in this project. Use /session_list to choose one." };
      await setActiveGatewaySession(input.chatKey, selected.id);
      await updateChatMode(input.chatKey, `agent:${selected.backend}`);
      return {
        text: `Active session: ${selected.id} · ${selected.backend} · ${selected.model ?? "default model"}`,
        buttons: channelControls(),
      };
    }
    if (operation === "stop") {
      if (current) await updateGatewaySession(current.id, { status: "stopped" });
      await setActiveGatewaySession(input.chatKey, null);
      return { text: "Stopped this conversation. The next message starts a new session." };
    }
    return {
      text: "Use /session_new for a new conversation, /session_list to choose one, or /stop to stop the current turn.",
    };
  }
  return null;
}
export function channelPrompt(connection: ChannelConnection, text: string): string {
  const command = channelCommand(text);
  const shortcut =
    command && channelCommands(connection.config).find((c) => c.command === command.name);
  if (!shortcut)
    return command ? `/${command.name}${command.args ? ` ${command.args}` : ""}` : text;
  const prompt = shortcut.prompt.replace(/\$ARGUMENTS/g, () => command.args);
  return shortcut.prompt.includes("$ARGUMENTS") || !command.args
    ? prompt
    : `${prompt}\n\n${command.args}`;
}
