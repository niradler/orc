import { loadConfig, resolveApiBase } from "@orc/core/config";
import type { HumanResponse } from "@orc/core/human-requests";
import { createOrcClient } from "@orc/sdk/client";
import type { ApiResult } from "@orc/sdk/types";
import type { ChatPendingRequest } from "./snapshot.js";

export type BuddyApiOptions = {
  baseUrl?: string | undefined;
  /** API secret; used directly as Bearer and to mint device tokens. */
  secret?: string | undefined;
  /** An already-minted access token; takes precedence over the secret. */
  token?: string | undefined;
};

export type SseMessage = { event: string; data: string };

export type ChatWaitingEntry = {
  thread_id: string;
  title: string;
  agent: string;
  request_key: string;
  kind: "question" | "approval";
  native_session_id: string | null;
  host: string | null;
};

function unwrap<T>(result: ApiResult<T>): T {
  if (result.error) throw new Error(result.error.error);
  return result.data;
}

/** Parses an SSE body into messages; comment keepalives are skipped. */
export async function* sseStream(response: Response): AsyncGenerator<SseMessage> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (data.length) yield { event, data: data.join("\n") };
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    if (signal.aborted) done();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createBuddyApi(options: BuddyApiOptions = {}) {
  const config = loadConfig();
  const baseUrl = (options.baseUrl ?? resolveApiBase(config)).replace(/\/$/, "");
  const secret = options.secret ?? config.api.secret;
  const credential = options.token ?? secret;
  const headers: Record<string, string> = credential
    ? { Authorization: `Bearer ${credential}` }
    : {};
  const client = createOrcClient({ baseUrl, ...(credential ? { secret: credential } : {}) });

  async function raw<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${baseUrl}/api${path}`, {
      method,
      headers: {
        ...headers,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await response.json().catch(() => ({}))) as { error?: string } & T;
    if (!response.ok) throw new Error(json.error ?? `${method} ${path} → ${response.status}`);
    return json;
  }

  return {
    baseUrl,
    headers,
    client,
    sessions: async () => unwrap(await client.sessions.live()).sessions,
    notifications: async (query: { project_id?: string } = {}) =>
      unwrap(await client.notifications.list({ limit: 50, ...query })),
    humanRequests: async () => unwrap(await client.humanRequests.list()),
    chatWaiting: async () =>
      (await raw<{ waiting: ChatWaitingEntry[] }>("GET", "/chat/waiting")).waiting,
    projects: async () => {
      const page = unwrap(await client.projects.list({ limit: 200 }));
      return page.projects.map((project) => ({ id: project.id, name: project.name }));
    },
    tokensToday: async (): Promise<number | null> => {
      const history = unwrap(await client.usage.history("7"));
      const today = new Date();
      const local = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      return history.daily.find((day) => day.date === local)?.tokens ?? null;
    },
    /** Reads the current version first: respond is optimistic-locked on it. */
    respondHuman: async (id: string, response: HumanResponse): Promise<void> => {
      const request = unwrap(await client.humanRequests.get(id));
      unwrap(await client.humanRequests.respond(id, request.version, response));
    },
    chatPermission: (runId: string, requestId: string, decision: "approved" | "denied") =>
      raw<{ ok: boolean }>("POST", `/chat/runs/${encodeURIComponent(runId)}/permission`, {
        requestId,
        decision,
      }),
    chatAnswer: (runId: string, requestId: string, answers: Record<string, string[]>) =>
      raw<{ ok: boolean }>("POST", `/chat/runs/${encodeURIComponent(runId)}/answer`, {
        requestId,
        answers,
      }),
    markRead: async (id: string): Promise<void> => {
      unwrap(await client.notifications.update(id, { read: true }));
    },
    createToken: async (days: number): Promise<{ token: string; expires_at: number }> => {
      if (!secret) throw new Error("Creating a device token needs the API secret (api.secret).");
      const expiresAt = Math.floor(Date.now() / 1000) + days * 86400;
      return raw<{ token: string; expires_at: number }>("POST", "/auth/token", {
        secret,
        expires_at: expiresAt,
      });
    },
  };
}

export type BuddyApi = ReturnType<typeof createBuddyApi>;

/**
 * Subscribes to the shared resource-change stream with reconnect. Calls
 * onMessage for `ready` and `change`; the caller refetches snapshots on both.
 */
export function subscribeEvents(
  api: BuddyApi,
  onMessage: (message: SseMessage) => void,
  signal: AbortSignal,
  onError?: (error: unknown) => void,
): void {
  void (async () => {
    let backoff = 1000;
    while (!signal.aborted) {
      try {
        const response = await fetch(`${api.baseUrl}/api/events`, {
          headers: { ...api.headers, Accept: "text/event-stream" },
          signal,
        });
        if (!response.ok || !response.body) throw new Error(`/api/events → ${response.status}`);
        backoff = 1000;
        for await (const message of sseStream(response)) {
          if (signal.aborted) break;
          onMessage(message);
        }
      } catch (error) {
        if (signal.aborted) return;
        onError?.(error);
      }
      if (signal.aborted) return;
      await sleep(backoff, signal);
      backoff = Math.min(backoff * 2, 15_000);
    }
  })();
}

/**
 * Attaches to one chat thread's running turn and tracks its pending requests.
 * The live stream replays the turn on attach, so runId and every outstanding
 * permission/question arrive without any extra endpoint. onUpdate fires with
 * the full pending set on each change; onEnd when the turn settles or the
 * stream drops (the caller re-checks /chat/waiting).
 */
export function watchChatThread(
  api: BuddyApi,
  threadId: string,
  onUpdate: (pending: ChatPendingRequest[]) => void,
  onEnd: () => void,
  signal: AbortSignal,
): void {
  void (async () => {
    let runId: string | null = null;
    let title = "Chat session";
    let projectId: string | null = null;
    const permissions = new Map<string, { tool: string; command: string }>();
    const questions = new Map<
      string,
      { hint: string; choices: string[]; answerable: boolean; questionIds: string[] }
    >();

    const emit = () => {
      const currentRunId = runId;
      if (!currentRunId) return;
      const pending: ChatPendingRequest[] = [
        ...[...permissions.entries()].map(([requestId, request]) => ({
          runId: currentRunId,
          requestId,
          threadId,
          kind: "approval" as const,
          title,
          hint: request.command ? `${request.tool}: ${request.command}` : request.tool,
          projectId,
          choices: [],
          answerable: true,
        })),
        ...[...questions.entries()].map(([requestId, question]) => ({
          runId: currentRunId,
          requestId,
          threadId,
          kind: "question" as const,
          title,
          hint: question.hint,
          projectId,
          choices: question.choices,
          questionIds: question.questionIds,
          answerable: question.answerable,
        })),
      ];
      onUpdate(pending);
    };

    try {
      const response = await fetch(
        `${api.baseUrl}/api/chat/threads/${encodeURIComponent(threadId)}/live`,
        { headers: { ...api.headers, Accept: "text/event-stream" }, signal },
      );
      if (response.status === 204 || !response.body) {
        onEnd();
        return;
      }
      if (!response.ok) throw new Error(`chat live → ${response.status}`);
      for await (const message of sseStream(response)) {
        if (signal.aborted) break;
        let event: { type?: string; [key: string]: unknown };
        try {
          event = JSON.parse(message.data);
        } catch {
          continue;
        }
        if (event.type === "thread") {
          runId = typeof event.runId === "string" ? event.runId : null;
          const thread = event.thread as { title?: string; projectId?: string | null } | undefined;
          title = thread?.title || "Chat session";
          projectId = thread?.projectId ?? null;
        } else if (event.type === "permission_request") {
          const data = event.data as { requestId: string; tool: string; command: string };
          permissions.set(data.requestId, { tool: data.tool, command: data.command });
          emit();
        } else if (event.type === "question_request") {
          const data = event.data as {
            requestId: string;
            questions: {
              id: string;
              question: string;
              options?: { label: string }[] | null;
            }[];
          };
          const first = data.questions[0];
          const choices = (first?.options ?? []).map((option) => option.label);
          questions.set(data.requestId, {
            hint: first?.question ?? "The agent is waiting for your answer.",
            choices,
            answerable: data.questions.length === 1 && choices.length > 0,
            questionIds: data.questions.map((question) => question.id),
          });
          emit();
        } else if (event.type === "request_resolved") {
          const requestId = typeof event.requestId === "string" ? event.requestId : "";
          permissions.delete(requestId);
          questions.delete(requestId);
          emit();
        }
      }
    } catch {
      // Reconnects are the caller's job: /chat/waiting re-lists live threads.
    }
    onEnd();
  })();
}

/** Question answers need every question id; the device picks one option for the first. */
export function chatAnswerFromChoice(
  pending: ChatPendingRequest,
  choice: string,
): Record<string, string[]> | null {
  const ids = pending.questionIds;
  const first = ids?.[0];
  if (ids?.length !== 1 || !first) return null;
  return { [first]: [choice] };
}
