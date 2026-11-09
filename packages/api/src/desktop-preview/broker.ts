import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { PreviewOperation, PreviewRequest } from "@orc/core/desktop-preview";
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from "@orc/core/errors";

interface Client {
  id: string;
  session: string | null;
  lease: string;
  seen: number;
  agentAccess: boolean;
  browserReady: boolean;
}
const CLIENT_TTL = 45_000;
const REQUEST_TTL = 120_000;

/** Ephemeral desktop delivery. A queued request is not evidence that a panel opened. */
export class PreviewBroker {
  private readonly clients = new Map<string, Client>();
  private readonly requests = new Map<string, PreviewRequest>();
  private failPending(clientId: string, reason: string): void {
    for (const request of this.requests.values())
      if (request.client_id === clientId && request.status === "queued") {
        request.status = "failed";
        request.error = reason;
      }
  }
  constructor(private readonly now: () => number = Date.now) {}
  private prune(): void {
    for (const [id, client] of this.clients)
      if (this.now() - client.seen > CLIENT_TTL) {
        this.failPending(id, "Desktop disconnected or its lease expired");
        this.clients.delete(id);
      }
    for (const [id, request] of this.requests) {
      if (request.status === "queued" && request.expires_at < this.now())
        request.status = "expired";
      if (request.expires_at + REQUEST_TTL < this.now()) this.requests.delete(id);
    }
  }
  register(
    id: string,
    session: string | null,
    lease?: string,
    agentAccess = false,
    browserReady = false,
  ): { client_id: string; lease: string } {
    this.prune();
    const current = this.clients.get(id);
    if (current) this.authenticate(id, lease);
    if (!current && this.clients.size >= 16)
      throw new ConflictError("Too many desktop clients. Close an unused desktop and retry.");
    const token = current?.lease ?? randomBytes(32).toString("hex");
    if (current && current.session !== session)
      this.failPending(id, "Desktop switched to another session");
    if (current?.agentAccess && !agentAccess)
      for (const request of this.requests.values()) {
        if (request.client_id === id && request.kind === "browser" && request.status === "queued") {
          request.status = "failed";
          request.error = "Browser control was revoked";
        }
      }
    this.clients.set(id, {
      id,
      session,
      lease: token,
      seen: this.now(),
      agentAccess,
      browserReady,
    });
    return { client_id: id, lease: token };
  }
  private authenticate(id: string, lease?: string): Client {
    this.prune();
    const client = this.clients.get(id);
    if (
      !client ||
      !lease ||
      !/^[a-f0-9]{64}$/.test(lease) ||
      lease.length !== client.lease.length ||
      !timingSafeEqual(Buffer.from(lease), Buffer.from(client.lease))
    )
      throw new UnauthorizedError("Desktop preview lease is unavailable or expired");
    client.seen = this.now();
    return client;
  }
  create(input: PreviewOperation): PreviewRequest {
    this.prune();
    const candidates = [...this.clients.values()].filter(
      (client) =>
        client.session === input.session_id && (!input.client_id || client.id === input.client_id),
    );
    const client = candidates[0];
    if (candidates.length !== 1 || !client)
      throw new ConflictError(
        candidates.length
          ? "More than one desktop is viewing this session. Supply client_id."
          : "No desktop is viewing this session. Open it in the desktop app and retry.",
      );
    if (input.kind === "browser" && !client.agentAccess)
      throw new ForbiddenError(
        "Enable browser control in Settings > Browser and this chat's Session settings first",
      );
    if (input.kind === "browser" && !client.browserReady)
      throw new ConflictError("No browser page is open for this session. Open a URL first.");
    if (this.requests.size >= 32)
      for (const [id, request] of this.requests) {
        if (request.status !== "queued") {
          this.requests.delete(id);
          break;
        }
      }
    if (this.requests.size >= 32)
      throw new ConflictError("Preview request queue is full. Retry shortly.");
    const request: PreviewRequest = {
      ...input,
      client_id: client.id,
      id: randomUUID(),
      status: "queued",
      error: null,
      expires_at: this.now() + REQUEST_TTL,
    };
    this.requests.set(request.id, request);
    return { ...request };
  }
  pending(id: string, lease: string | undefined): PreviewRequest[] {
    const client = this.authenticate(id, lease);
    return [...this.requests.values()]
      .filter(
        (request) =>
          request.client_id === id &&
          request.session_id === client.session &&
          request.status === "queued",
      )
      .map((request) => ({ ...request }));
  }
  acknowledge(
    clientId: string,
    lease: string | undefined,
    id: string,
    status: "opened" | "completed" | "failed",
    error: string | null,
    result?: unknown,
  ): PreviewRequest {
    const client = this.authenticate(clientId, lease);
    const request = this.get(id);
    if (request.client_id !== client.id || request.session_id !== client.session)
      throw new UnauthorizedError("Preview request belongs to another desktop or session");
    if (request.status !== "queued") return request;
    const current = this.requests.get(id);
    if (!current) throw new NotFoundError("Preview request", id);
    current.status = status;
    current.error = error;
    if (result !== undefined) current.result = result;
    return { ...current };
  }
  cancel(id: string, reason: string): PreviewRequest {
    this.prune();
    const request = this.requests.get(id);
    if (!request) throw new NotFoundError("Preview request", id);
    if (request.status === "queued") {
      request.status = "failed";
      request.error = reason;
    }
    return { ...request };
  }
  get(id: string): PreviewRequest {
    this.prune();
    const request = this.requests.get(id);
    if (!request) throw new NotFoundError("Preview request", id);
    return { ...request };
  }
  list(session: string): { client_id: string; agent_access: boolean; browser_ready: boolean }[] {
    this.prune();
    return [...this.clients.values()]
      .filter((client) => client.session === session)
      .map((client) => ({
        client_id: client.id,
        agent_access: client.agentAccess,
        browser_ready: client.browserReady,
      }));
  }
  close(id: string, lease: string | undefined): void {
    this.authenticate(id, lease);
    this.failPending(id, "Desktop disconnected");
    this.clients.delete(id);
  }
}
export const previewBroker = new PreviewBroker();
