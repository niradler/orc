import {
  providerExecutable,
  providerForAgent,
  resolveProviderEnvironment,
} from "@orc/core/provider-service";
import type { AgentEvent, AgentSession, SessionOpts } from "./types.js";

export function providerSessionOptions<T extends Partial<SessionOpts>>(
  backend: string,
  opts: T,
  resuming = false,
): T {
  const agent =
    backend === "codex-cli"
      ? "codex"
      : backend === "claude-cli"
        ? "claude"
        : backend === "acpx"
          ? (opts.acpxAgent ?? "claude")
          : backend === "acp"
            ? (opts.acpAgent ?? "acp")
            : backend;
  const profile = providerForAgent(agent, opts.providerId, resuming || !opts.providerId);
  if (!profile) return opts;
  const resolved = resolveProviderEnvironment(profile);
  return {
    ...opts,
    providerId: profile.id,
    providerEnv: { ...resolved.env, ...opts.providerEnv },
    providerRedact: resolved.redact,
    providerTextRedactor: resolved.stream,
    ...(opts.model === undefined && profile.model ? { model: profile.model } : {}),
    ...(opts.chatAgentOptions === undefined && profile.options
      ? { chatAgentOptions: profile.options }
      : {}),
    ...(opts.executionHost ? {} : { providerExecutable: providerExecutable(profile) }),
  };
}
function redactTree(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactTree(item, redact));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [redact(key), redactTree(item, redact)]),
    );
  return value;
}
export function redactProviderEvent(
  event: AgentEvent,
  redact: (text: string) => string,
): AgentEvent {
  if (
    event.type === "text" ||
    event.type === "thinking" ||
    event.type === "error" ||
    event.type === "system_status"
  )
    return { ...event, data: redact(event.data) };
  if (event.type === "tool_result")
    return { ...event, data: { ...event.data, content: redact(event.data.content) } };
  if (event.type === "result")
    return {
      ...event,
      data: {
        ...event.data,
        ...(event.data.usage !== undefined ? { usage: redactTree(event.data.usage, redact) } : {}),
      },
    };
  if (event.type === "tool_use") {
    let input = redact(event.data.input);
    try {
      input = JSON.stringify(redactTree(JSON.parse(event.data.input), redact));
    } catch {}
    return { ...event, data: { ...event.data, input } };
  }
  if (event.type === "permission_request")
    return {
      ...event,
      data: {
        ...event.data,
        command: redact(event.data.command),
        ...(event.data.input
          ? { input: redactTree(event.data.input, redact) as Record<string, unknown> }
          : {}),
      },
    };
  if (event.type === "question_request")
    return {
      ...event,
      data: {
        ...event.data,
        questions: event.data.questions.map((question) => ({
          ...question,
          header: redact(question.header),
          question: redact(question.question),
          options: question.options?.map((option) => ({
            label: redact(option.label),
            description: redact(option.description),
          })),
        })),
      },
    };
  return event;
}
export function withProviderRedaction(session: AgentSession, opts: SessionOpts): AgentSession {
  if (!opts.providerRedact) return session;
  const redact = opts.providerRedact;
  const protect =
    <A extends unknown[], R>(method: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        return await method.apply(session, args);
      } catch (error) {
        throw new Error(redact(error instanceof Error ? error.message : String(error)));
      }
    };
  const wrapped: AgentSession = {
    id: session.id,
    get capabilities() {
      return session.capabilities;
    },
    send: protect(session.send),
    respondPermission: session.respondPermission.bind(session),
    alive: session.alive.bind(session),
    close: protect(session.close),
    ...(session.interrupt ? { interrupt: session.interrupt.bind(session) } : {}),
    ...(session.steer ? { steer: session.steer.bind(session) } : {}),
    ...(session.setPermissionMode
      ? { setPermissionMode: session.setPermissionMode.bind(session) }
      : {}),
    ...(session.respondQuestion ? { respondQuestion: session.respondQuestion.bind(session) } : {}),
    ...(session.getRuntimeSessionId
      ? { getRuntimeSessionId: session.getRuntimeSessionId.bind(session) }
      : {}),
    ...(session.waitingForHuman ? { waitingForHuman: session.waitingForHuman.bind(session) } : {}),
    async *events() {
      const text = opts.providerTextRedactor?.();
      const thinking = opts.providerTextRedactor?.();
      try {
        for await (const event of session.events()) {
          if (event.type === "result") {
            const tail = text?.flush();
            if (tail) yield { type: "text", data: tail };
            const tailThinking = thinking?.flush();
            if (tailThinking) yield { type: "thinking", data: tailThinking };
          }
          const stream =
            event.type === "text" ? text : event.type === "thinking" ? thinking : undefined;
          if (stream && (event.type === "text" || event.type === "thinking")) {
            const data = stream.push(event.data);
            if (data) yield { ...event, data };
          } else yield redactProviderEvent(event, redact);
        }
      } catch (error) {
        throw new Error(redact(error instanceof Error ? error.message : String(error)));
      }
      const tail = text?.flush();
      if (tail) yield { type: "text", data: tail };
      const thought = thinking?.flush();
      if (thought) yield { type: "thinking", data: thought };
    },
  };
  return wrapped;
}
