import { createHash, randomUUID } from "node:crypto";
import { loadConfig } from "@orc/core/config";
import { resolveExecHost } from "@orc/core/exec-host";
import type { HumanRequest } from "@orc/core/human-requests";
import type { RuleDecision } from "@orc/core/rule-types";
import { getSqlite } from "@orc/db/client";
import { currentHumanRequest, HumanRequestStore } from "@orc/db/human-requests";
import { RuleStore } from "@orc/db/rules";
import type { AgentEvent, AgentSession, SessionOpts } from "./types.js";

type Pause = Extract<AgentEvent, { type: "permission_request" | "question_request" }>;
type Wait = {
  abort: AbortController;
  requests: HumanRequest[];
  responding: boolean;
  task: Promise<void>;
};

export function withHumanRequests(
  session: AgentSession,
  backend: string,
  opts: SessionOpts,
): AgentSession {
  const agent = backend === "codex-cli" ? "codex" : backend;
  if (!loadConfig().rules.enabled || !["claude", "codex"].includes(agent)) return session;
  const store = new HumanRequestStore(getSqlite());
  const owner = randomUUID();
  const waits = new Map<string, Wait>();
  const queue: AgentEvent[] = [];
  let wake: (() => void) | undefined;
  let finished = false;
  let closed = false;

  function emit(event: AgentEvent): void {
    queue.push(event);
    wake?.();
    wake = undefined;
  }
  function stopWait(wait: Wait, unavailable: boolean): void {
    wait.abort.abort();
    for (const record of wait.requests) {
      const current = store.get(record.id);
      if (current.status === "pending" && !unavailable) store.cancel(current.id, current.version);
      else if (["pending", "answered"].includes(current.status))
        store.unavailable(current.id, current.version);
    }
  }
  async function waitForAnswer(record: HumanRequest, wait: Wait): Promise<HumanRequest> {
    while (!wait.abort.signal.aborted) {
      store.heartbeat(record.id, owner);
      const current = currentHumanRequest(store, record.id);
      if (
        current.status === "answered" &&
        wait.requests.every((record) => currentHumanRequest(store, record.id).status === "answered")
      )
        return current;
      if (!["pending", "answered"].includes(current.status))
        throw new Error("Human request no longer pending");
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          wait.abort.signal.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, 250);
        wait.abort.signal.addEventListener("abort", done, { once: true });
      });
    }
    throw new Error("Native request cancelled");
  }
  function decisionFor(event: Pause): RuleDecision {
    return new RuleStore(store.db).evaluate({
      id: event.data.requestId,
      session_id: session.id,
      backend: agent,
      cwd: opts.cwd,
      phase: `runtime:${event.type}`,
      tool: event.type === "permission_request" ? event.data.tool : "question",
      input:
        event.type === "permission_request"
          ? (event.data.input ?? { command: event.data.command })
          : { questions: event.data.questions },
    });
  }
  async function answer(event: Pause, decision: RuleDecision, wait: Wait): Promise<void> {
    try {
      const actions = decision.human_requests ?? [];
      const rules = new RuleStore(store.db);
      const revisions = rules.active(opts.cwd);
      const bindings = actions.map((action) => {
        const revision = revisions.find((entry) => entry.id === action.revision_id);
        if (!revision) throw new Error("Rule changed before request creation");
        return { revision_id: revision.id, rule_id: action.rule_id, workspace: revision.workspace };
      });
      const host =
        opts.executionHost === undefined
          ? resolveExecHost()
          : opts.executionHost
            ? { kind: "ssh" as const, alias: opts.executionHost }
            : { kind: "local" as const };
      const questions = event.type === "question_request" ? event.data.questions : [null];
      if (questions.some((question) => question?.isSecret))
        throw new Error("Secret input cannot enter the inbox");
      for (const question of questions) {
        const record = store.create(
          {
            origin: {
              session_id: session.id,
              backend: agent,
              request_id: createHash("sha256")
                .update(
                  JSON.stringify([event.data.requestId, question?.id ?? "approval", bindings]),
                )
                .digest("hex"),
            },
            project_id:
              revisions.find((revision) => revision.id === bindings[0]?.revision_id)?.project_id ??
              null,
            rule_bindings: bindings,
            kind: event.type === "question_request" ? "question" : "approval",
            prompt:
              question?.question ??
              [...new Set(actions.map((action) => action.target.prompt))].join("\n"),
            choices: question?.options?.map((option) => option.label) ?? [],
            choice_descriptions: Object.fromEntries(
              question?.options?.map((option) => [option.label, option.description]) ?? [],
            ),
            multi_select: question?.multiSelect ?? false,
            notify: [...new Set(actions.flatMap((action) => action.target.notify))],
            expires_in_seconds: Math.min(
              ...actions.map((action) => action.target.expires_in_seconds),
            ),
            ...(event.type === "permission_request"
              ? {
                  action: {
                    tool: event.data.tool,
                    input: event.data.input ?? { command: event.data.command },
                    cwd: event.data.cwd ?? opts.cwd,
                    host: host.kind === "ssh" ? host.alias : "local",
                  },
                }
              : {}),
          },
          owner,
        );
        wait.requests.push(record);
      }
      const replies = await Promise.all(wait.requests.map((record) => waitForAnswer(record, wait)));
      if (wait.abort.signal.aborted || !session.alive())
        throw new Error("Originating runtime is unavailable");
      wait.responding = true;
      if (event.type === "permission_request") {
        const response = replies[0]?.response;
        if (response?.kind !== "approval") throw new Error("Wrong approval response");
        session.respondPermission(event.data.requestId, response.approved ? "approved" : "denied");
      } else {
        if (!session.respondQuestion) throw new Error("Native answer delivery unsupported");
        const answers = Object.fromEntries(
          event.data.questions.map((question, index) => {
            const response = replies[index]?.response;
            if (response?.kind !== "question") throw new Error("Wrong question response");
            return [question.id, response.selected_choices ?? [response.answer]];
          }),
        );
        await session.respondQuestion(event.data.requestId, answers);
      }
      for (const reply of replies) {
        const current = store.get(reply.id);
        if (current.status === "answered") store.acknowledge(current.id, current.version);
      }
      emit({ type: "system_status", data: "Human response sent to the originating agent" });
    } catch {
      if (!wait.abort.signal.aborted) {
        stopWait(wait, true);
        emit({
          type: "system_status",
          data: "Human response unavailable; the action was not authorized",
        });
        try {
          if (event.type === "permission_request" && session.alive())
            session.respondPermission(event.data.requestId, "denied");
          else await session.close();
        } catch {
          /* Native connection may already be gone. */
        }
      }
    } finally {
      waits.delete(event.data.requestId);
    }
  }
  async function pump(): Promise<void> {
    try {
      for await (const event of session.events()) {
        if (closed) break;
        if (event.type === "permission_request" || event.type === "question_request") {
          const decision = decisionFor(event);
          if (decision.decision === "deny") {
            if (event.type === "permission_request")
              session.respondPermission(event.data.requestId, "denied");
            else await session.close();
            emit({ type: "system_status", data: "Action denied by ORC rule" });
            continue;
          }
          if (decision.human_requests?.length) {
            const wait: Wait = {
              abort: new AbortController(),
              requests: [],
              responding: false,
              task: Promise.resolve(),
            };
            waits.set(event.data.requestId, wait);
            wait.task = answer(event, decision, wait);
            emit({ type: "system_status", data: "Waiting for you in Attention needed" });
            continue;
          }
        }
        if (event.type === "request_resolved") {
          const wait = waits.get(event.data.requestId);
          if (wait && !wait.responding) stopWait(wait, false);
        }
        if (event.type === "result" || event.type === "error")
          for (const wait of waits.values()) if (!wait.responding) stopWait(wait, true);
        emit(event);
      }
    } catch {
      emit({
        type: "error",
        data: "Agent connection ended before the human response could be delivered",
      });
    } finally {
      const pending = [...waits.values()];
      for (const wait of pending) if (!wait.responding) stopWait(wait, true);
      await Promise.allSettled(pending.map((wait) => wait.task));
      finished = true;
      wake?.();
    }
  }
  async function close(): Promise<void> {
    closed = true;
    for (const wait of waits.values()) stopWait(wait, false);
    await session.close();
  }
  return {
    id: session.id,
    getRuntimeSessionId: () => session.getRuntimeSessionId?.(),
    send: (prompt, images) => session.send(prompt, images),
    respondPermission: (id, result) => session.respondPermission(id, result),
    ...(session.respondQuestion
      ? {
          respondQuestion: (id: string, answers: Record<string, string[]>) =>
            session.respondQuestion?.(id, answers),
        }
      : {}),
    alive: () => session.alive(),
    waitingForHuman: () => waits.size > 0 || session.waitingForHuman?.() === true,
    close,
    async *events() {
      finished = false;
      const pumping = pump();
      try {
        while (!finished || queue.length) {
          const event = queue.shift();
          if (event) yield event;
          else
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
        }
      } finally {
        if (!finished) await close();
        await pumping;
      }
    },
  };
}
