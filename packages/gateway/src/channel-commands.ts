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
    "Use /agent default, /model default or /project default to restore routing defaults.",
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
  if (command.name === "status")
    return {
      text: `Project: ${input.projectId}\nFolder: ${input.cwd}\nAgent: ${agent}\nModel: ${current?.model ?? (agent === input.defaultAgent ? input.defaultModel : undefined) ?? "provider default"}\nSession: ${current ? `${current.id} (${current.status})` : "new conversation"}`,
    };
  if (command.name === "project" || command.name === "projects") {
    const projects = getSqlite()
      .query<{ id: string; name: string; scope: string | null }, []>(
        "SELECT id,name,scope FROM projects WHERE status='active' ORDER BY name LIMIT 1000",
      )
      .all()
      .filter((p) => !input.allowedProjects.length || input.allowedProjects.includes(p.id));
    if (!command.args)
      return {
        text: `Current project: ${projects.find((p) => p.id === input.projectId)?.name ?? input.projectId}\nChoose a project; its folder becomes the agent working directory.`,
        buttons: projects.slice(0, 20).map((p) => [{ label: p.name, value: `/project ${p.id}` }]),
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
    };
  }
  if (command.name === "agent") {
    const agents = listRegisteredBackends();
    if (!command.args)
      return {
        text: `Current agent: ${agent}\nDefault: ${input.defaultAgent}`,
        buttons: [
          [{ label: "Default agent", value: "/agent default" }],
          ...agents.slice(0, 15).map((name) => [{ label: name, value: `/agent ${name}` }]),
        ],
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
    return { text: `Agent: ${selected}. The next message uses its selected conversation.` };
  }
  if (command.name === "model") {
    const session = await ensureChannelSession(input);
    if (!command.args || command.args === "list") {
      const models = await discoverAgentModels(
        agent.replace(/-cli$/, ""),
        resolveExecHost(),
        input.cwd,
      ).catch(() => []);
      return {
        text: `Current model: ${session.model ?? (agent === input.defaultAgent ? input.defaultModel : undefined) ?? "provider default"}\nUse /model <id> or choose a model.`,
        buttons: [
          [{ label: "Default model", value: "/model default" }],
          ...models.slice(0, 15).map((m) => [{ label: m.label, value: `/model ${m.id}` }]),
        ],
      };
    }
    if (command.args !== "default" && !/^[a-z0-9][a-z0-9._:/@+-]{0,199}$/i.test(command.args))
      return { text: "Use /model <model-id> or /model default." };
    const model =
      command.args === "default"
        ? agent === input.defaultAgent
          ? (input.defaultModel ?? null)
          : null
        : command.args;
    await updateGatewaySession(session.id, { model });
    return { text: `Model: ${model ?? "provider default"}. It takes effect on the next message.` };
  }
  if (command.name === "session" || command.name === "sessions") {
    const [operation = "list", argument = ""] =
      command.name === "sessions" ? ["list"] : command.args.split(/\s+/);
    const sessions = (await listGatewaySessions(input.chatKey, input.projectId)).filter(
      (s) => s.project_id === input.projectId,
    );
    if (operation === "list")
      return {
        text: sessions.length
          ? sessions
              .map(
                (s, i) =>
                  `${i + 1}. ${s.id === current?.id ? "▶ " : ""}${s.id} · ${s.backend} · ${s.model ?? "default model"} · ${s.status}`,
              )
              .join("\n")
          : "No sessions in this project yet. Send a message or use /session new.",
        buttons: [
          [{ label: "New conversation", value: "/session new" }],
          ...sessions
            .filter((s) => s.status !== "stopped")
            .slice(0, 15)
            .map((s) => [
              { label: `${s.backend} · ${s.id.slice(-6)}`, value: `/session switch ${s.id}` },
            ]),
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
      return { text: `Created and activated ${agent} session ${session.id}.` };
    }
    if (operation === "switch") {
      const selected = /^\d+$/.test(argument)
        ? sessions[Number(argument) - 1]
        : sessions.find((s) => s.id === argument || s.id.endsWith(argument));
      if (!selected || selected.status === "stopped")
        return { text: "Session is unavailable in this project. Use /session list." };
      await setActiveGatewaySession(input.chatKey, selected.id);
      await updateChatMode(input.chatKey, `agent:${selected.backend}`);
      return {
        text: `Active session: ${selected.id} · ${selected.backend} · ${selected.model ?? "default model"}`,
      };
    }
    if (operation === "stop") {
      if (current) await updateGatewaySession(current.id, { status: "stopped" });
      await setActiveGatewaySession(input.chatKey, null);
      return { text: "Stopped this conversation. The next message starts a new session." };
    }
    return {
      text: "Use /session new, /session list, /session switch <id-or-number>, or /session stop.",
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
