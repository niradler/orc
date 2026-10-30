import { createHash, randomUUID } from "node:crypto";
import {
  type ChannelConnection,
  ChannelConnectionSchema,
  type ChannelInbound,
  type ChannelReceipt,
  type ChannelRoute,
  type ChannelSend,
  ChannelSendSchema,
  type ChannelTarget,
  type ChannelView,
} from "@orc/core/channels";
import { loadConfig } from "@orc/core/config";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@orc/core/errors";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "@orc/core/secrets";
import { ChannelStore } from "@orc/db/channels";
import { getSqlite } from "@orc/db/client";
import {
  type ChannelTransport,
  channelProviders,
  createChannelTransport,
  ProviderFailure,
  type ProviderIdentity,
  type TransportFactory,
} from "./providers.js";
import { renderMessage } from "./render.js";
import { routeMessage } from "./routing.js";

export type ChannelHandler = (
  route: ChannelRoute,
  message: ChannelInbound,
  target: ChannelTarget,
) => Promise<void>;
type Live = {
  transport: ChannelTransport;
  fingerprint: string;
  resource: string;
  identity: ProviderIdentity;
  error: string | null;
};
const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const forbiddenKeys = new Set([
  "token",
  "access_token",
  "authorization",
  "__proto__",
  "prototype",
  "constructor",
]);

export class ChannelService {
  private readonly owner = randomUUID();
  private readonly live = new Map<string, Live>();
  private readonly errors = new Map<string, string>();
  private readonly conflicts = new Set<string>();
  private readonly turns = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, number>();
  private readonly quotas = new Map<string, { until: number; count: number }>();
  private pendingTotal = 0;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private reconciling: Promise<void> | undefined;
  handler: ChannelHandler | undefined;
  beforeConnect: ((connection: ChannelConnection) => Promise<void>) | undefined;
  control: ((message: ChannelInbound, target: ChannelTarget) => Promise<boolean>) | undefined;

  constructor(
    readonly store: ChannelStore,
    private readonly factory: TransportFactory = createChannelTransport,
  ) {}

  connections(): ChannelConnection[] {
    const config = loadConfig();
    const configured = this.store.connections();
    for (const old of config.channels)
      if (!configured.some((c) => c.id === old.id)) {
        const migrated = {
          ...old,
          revision: 0,
          credentials: Object.fromEntries(
            Object.entries(old.credentials).map(([k, value]) => [
              k,
              value.startsWith("env:") ? value : encryptSecret(decryptSecret(value)),
            ]),
          ),
        };
        this.store.saveConnection(migrated);
        configured.push({ ...migrated, revision: 1 });
      }
    for (const provider of channelProviders) {
      if (configured.some((c) => c.id === `legacy-${provider.id}`)) continue;
      const legacy = config.gateway[provider.id];
      if (!provider.credentials.some((field) => !!legacy[field.key as keyof typeof legacy]))
        continue;
      configured.push(
        ChannelConnectionSchema.parse({
          id: `legacy-${provider.id}`,
          name: provider.name,
          provider: provider.id,
          enabled: false,
          credentials: Object.fromEntries(
            provider.credentials.map((field) => [
              field.key,
              process.env[field.env]
                ? `env:${field.env}`
                : String(legacy[field.key as keyof typeof legacy] ?? ""),
            ]),
          ),
          targets: legacy.default_chat_id
            ? [
                {
                  id: "me",
                  name: "Default recipient",
                  chat_id: legacy.default_chat_id,
                  user_ids: legacy.authorized_users.map(String),
                },
              ]
            : [],
        }),
      );
    }
    return configured;
  }
  connection(id: string) {
    const c = this.connections().find((v) => v.id === id);
    if (!c) throw new NotFoundError("Channel connection", id);
    return c;
  }
  managesAccount(provider: string, token: string): boolean {
    return this.connections().some((c) => {
      if (!c.enabled || c.provider !== provider) return false;
      try {
        return this.credentials(c)[provider === "telegram" ? "token" : "bot_token"] === token;
      } catch {
        return false;
      }
    });
  }
  credentials(connection: ChannelConnection): Record<string, string> {
    return Object.fromEntries(
      Object.entries(connection.credentials).map(([k, v]) => [
        k,
        v.startsWith("env:") ? (process.env[v.slice(4)] ?? "") : decryptSecret(v),
      ]),
    );
  }
  list(project?: string | null): ChannelView[] {
    return this.connections().map((c) => {
      const live = this.live.get(c.id);
      const credentials = Object.fromEntries(
        channelProviders
          .find((p) => p.id === c.provider)
          ?.credentials.map((field) => {
            const value = c.credentials[field.key];
            return [
              field.key,
              {
                configured: !!value && (!value.startsWith("env:") || !!process.env[value.slice(4)]),
                source: !value ? "missing" : value.startsWith("env:") ? "environment" : "stored",
              },
            ];
          }) ?? [],
      );
      const error = this.errors.get(c.id) ?? live?.error ?? null;
      return {
        id: c.id,
        name: c.name,
        provider: c.provider,
        enabled: c.enabled,
        revision: c.revision,
        config: project === undefined ? c.config : {},
        credentials,
        identity: live?.identity ?? null,
        status: error ? "error" : !c.enabled ? "disabled" : live ? "ready" : "setup",
        error,
        targets: c.targets.filter(
          (t) =>
            project === undefined ||
            !t.project_ids.length ||
            (!!project && t.project_ids.includes(project)),
        ),
        routes:
          project === undefined
            ? c.routes
            : c.routes.filter((r) => r.action.type === "agent" && r.action.project_id === project),
      } as ChannelView;
    });
  }
  async save(input: unknown): Promise<ChannelView> {
    const parsed = ChannelConnectionSchema.parse(input);
    const previous = this.connections().find((c) => c.id === parsed.id);
    if (previous && previous.provider !== parsed.provider)
      throw new ValidationError("A connection's provider cannot change");
    const keys: string[] =
      channelProviders.find((p) => p.id === parsed.provider)?.credentials.map((c) => c.key) ?? [];
    for (const k of Object.keys(parsed.credentials))
      if (!keys.includes(k)) throw new ValidationError(`Unknown credential field: ${k}`);
    parsed.credentials = {
      ...previous?.credentials,
      ...Object.fromEntries(
        Object.entries(parsed.credentials)
          .filter(([, v]) => v !== "")
          .map(([k, v]) => {
            if (v.startsWith("env:") && !/^env:ORC_[A-Z0-9_]+$/.test(v))
              throw new ValidationError("Use an ORC environment variable reference");
            if (
              v.startsWith("env:") &&
              !channelProviders
                .find((p) => p.id === parsed.provider)
                ?.credentials.some((f) => f.key === k && `env:${f.env}` === v)
            )
              throw new ValidationError(
                "Use the documented channel credential environment variable",
              );
            return [k, v.startsWith("env:") ? v : encryptSecret(v)];
          }),
      ),
    };
    parsed.credentials = Object.fromEntries(
      Object.entries(parsed.credentials).map(([key, value]) => [
        key,
        value.startsWith("env:") || isEncryptedSecret(value) ? value : encryptSecret(value),
      ]),
    );
    for (const route of parsed.routes)
      if (
        route.action.type === "agent" &&
        !this.store.db.query("SELECT id FROM projects WHERE id=?").get(route.action.project_id)
      )
        throw new ValidationError("Route project does not exist");
    for (const target of parsed.targets)
      for (const id of target.project_ids)
        if (!this.store.db.query("SELECT id FROM projects WHERE id=?").get(id))
          throw new ValidationError("Target project does not exist");
    this.store.saveConnection(parsed);
    if (this.conflicts.has(parsed.id)) await this.stopConnection(parsed.id);
    this.conflicts.delete(parsed.id);
    this.errors.delete(parsed.id);
    await this.reconcile();
    return this.list().find((c) => c.id === parsed.id) as ChannelView;
  }
  async verify(id: string) {
    const c = this.connection(id);
    const transport = this.factory(c, this.credentials(c));
    return transport.identity();
  }
  async start() {
    this.stopped = false;
    await this.reconcile();
    this.timer ??= setInterval(() => void this.reconcile().catch(() => {}), 15000);
    this.timer.unref();
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.reconciling;
    for (const [id] of this.live) await this.stopConnection(id);
  }
  private async stopConnection(id: string) {
    const live = this.live.get(id);
    if (!live) return;
    this.live.delete(id);
    await live.transport.stop();
    this.store.release(live.resource, this.owner);
  }
  async reconcile(): Promise<void> {
    if (this.reconciling) {
      await this.reconciling;
      return this.reconcile();
    }
    this.reconciling = this.refresh();
    try {
      await this.reconciling;
    } finally {
      this.reconciling = undefined;
    }
  }
  private async refresh() {
    if (this.stopped) return;
    this.store.prune();
    for (const [key, quota] of this.quotas) if (quota.until <= Date.now()) this.quotas.delete(key);
    const connections = this.connections();
    for (const [id, live] of this.live) {
      const current = connections.find((c) => c.id === id);
      if (
        !current?.enabled ||
        this.conflicts.has(id) ||
        fingerprint([current.id, current.provider, current.credentials, current.config]) !==
          live.fingerprint ||
        !this.store.lease(live.resource, this.owner)
      )
        await this.stopConnection(id);
    }
    for (const c of connections.filter((c) => c.enabled)) {
      if (this.stopped) return;
      if (this.live.has(c.id) || this.conflicts.has(c.id)) continue;
      try {
        await this.beforeConnect?.(c);
        const credentials = this.credentials(c);
        const resource = fingerprint([
          c.provider,
          credentials[c.provider === "telegram" ? "token" : "bot_token"],
        ]);
        if ([...this.live.values()].some((live) => live.resource === resource))
          throw new ConflictError("This provider account is already connected");
        if (!this.store.lease(resource, this.owner))
          throw new ConflictError("Another ORC process owns this provider account");
        try {
          const transport = this.factory(c, credentials);
          const identity = await transport.identity();
          this.live.set(c.id, {
            transport,
            fingerprint: fingerprint([c.id, c.provider, c.credentials, c.config]),
            resource,
            identity,
            error: null,
          });
          await transport.start(
            (message) => {
              void this.receive(message).catch(() =>
                this.errors.set(
                  c.id,
                  "Inbound processing failed; inspect the originating session.",
                ),
              );
            },
            (code) => {
              const live = this.live.get(c.id);
              if (live) live.error = code || null;
              if (code.includes("409")) {
                this.conflicts.add(c.id);
                this.errors.set(
                  c.id,
                  "Another Telegram poller owns this bot. Stop that listener, then save the connection to retry.",
                );
              }
            },
          );
          if (!this.conflicts.has(c.id)) this.errors.delete(c.id);
        } catch (error) {
          await this.stopConnection(c.id);
          this.store.release(resource, this.owner);
          throw error;
        }
      } catch (error) {
        this.errors.set(
          c.id,
          error instanceof ProviderFailure ||
            error instanceof ConflictError ||
            error instanceof ValidationError
            ? error.message
            : "Unable to connect; verify credentials and permissions.",
        );
      }
    }
  }
  private authorizedTarget(c: ChannelConnection, id: string, project?: string | null) {
    const target = c.targets.find((t) => t.id === id);
    if (
      !target ||
      (project !== undefined &&
        target.project_ids.length &&
        (!project || !target.project_ids.includes(project)))
    )
      throw new ForbiddenError("Channel destination is not allowed in this project");
    return target;
  }
  private payloads(
    c: ChannelConnection,
    target: ChannelTarget,
    input: Pick<ChannelSend, "message" | "overrides" | "thread_id">,
  ) {
    if (target.thread_id && input.thread_id && target.thread_id !== input.thread_id)
      throw new ForbiddenError("Thread is outside the configured destination");
    const thread = input.thread_id ?? target.thread_id;
    const rendered = renderMessage(c.provider, input.message);
    const routing =
      c.provider === "telegram"
        ? { chat_id: target.chat_id, ...(thread ? { message_thread_id: Number(thread) } : {}) }
        : { channel: target.chat_id, ...(thread ? { thread_ts: thread } : {}) };
    const defaults = c.config.message_defaults;
    if (
      defaults !== undefined &&
      (!defaults || typeof defaults !== "object" || Array.isArray(defaults))
    )
      throw new ValidationError("config.message_defaults must be a native provider JSON object");
    const overrides = { ...((defaults ?? {}) as Record<string, unknown>), ...input.overrides };
    for (const k of Object.keys(overrides))
      if (
        forbiddenKeys.has(k) ||
        k in routing ||
        ["chat_id", "channel", "message_thread_id", "thread_ts", "message_id", "ts"].includes(k)
      )
        throw new ValidationError(`ORC owns credential/routing field: ${k}`);
    // Explicit native content is one intact provider payload, never rewritten/split.
    return {
      payloads: (input.overrides || defaults
        ? [rendered.payloads.length === 1 ? rendered.payloads[0] : { text: input.message.text }]
        : rendered.payloads
      ).map((p) => ({ ...p, ...overrides, ...routing })),
      warnings: input.overrides || defaults ? [] : rendered.warnings,
    };
  }
  async send(raw: unknown): Promise<ChannelReceipt & { warnings: string[] }> {
    if (this.stopped) throw new ConflictError("Channel runtime is stopping");
    const input = ChannelSendSchema.parse(raw);
    const c = this.connection(input.connection);
    const target = this.authorizedTarget(c, input.target, input.project_id);
    if (!c.enabled || !target.outbound) throw new ForbiddenError("Outbound messaging is disabled");
    const { payloads, warnings } = this.payloads(c, target, input);
    const { receipt, fresh } = this.store.reserve(
      c.id,
      target.id,
      input.project_id ?? null,
      input,
      input.idempotency_key,
    );
    if (!fresh) return { ...receipt, warnings };
    try {
      const transport = this.live.get(c.id)?.transport ?? this.factory(c, this.credentials(c));
      for (const payload of payloads) {
        receipt.provider_ids.push(await transport.send(payload));
        this.store.save(receipt);
      }
      receipt.status = "accepted";
    } catch (error) {
      receipt.status = receipt.provider_ids.length
        ? "partial"
        : error instanceof ProviderFailure && !error.ambiguous
          ? "failed"
          : "unknown";
      receipt.error =
        error instanceof ProviderFailure
          ? error.message
          : "Delivery failed; inspect provider status before retrying.";
    }
    this.store.save(receipt);
    return { ...receipt, warnings };
  }
  get(id: string, project?: string | null) {
    const receipt = this.store.get(id);
    this.authorizedTarget(this.connection(receipt.connection), receipt.target, project);
    if (project !== undefined && receipt.project_id !== project)
      throw new ForbiddenError("Receipt belongs to another project");
    return receipt;
  }
  async edit(
    id: string,
    input: Pick<ChannelSend, "message" | "overrides" | "project_id" | "thread_id">,
  ) {
    const receipt = this.get(id, input.project_id);
    const c = this.connection(receipt.connection);
    const target = this.authorizedTarget(c, receipt.target, input.project_id);
    if (!c.enabled || !target.outbound || receipt.status !== "accepted")
      throw new ConflictError("Message cannot be edited in its current state");
    const { payloads } = this.payloads(c, target, input);
    if (payloads.length !== receipt.provider_ids.length)
      throw new ValidationError("Editing must preserve the number of provider message chunks");
    const transport = this.live.get(c.id)?.transport ?? this.factory(c, this.credentials(c));
    for (const [index, payload] of payloads.entries())
      await transport.edit(receipt.provider_ids[index] as string, payload);
    return receipt;
  }
  async beginPairing(id: string) {
    const c = this.connection(id);
    if (!c.enabled) throw new ValidationError("Enable this connection before pairing");
    const identity = await this.verify(id);
    const pairing = this.store.createPairing(id, c.revision);
    return {
      id: pairing.id,
      expires_at: pairing.expires_at,
      url:
        c.provider === "telegram"
          ? `https://t.me/${encodeURIComponent(identity.name)}?start=orc_${pairing.token}`
          : `https://app.slack.com/client/${encodeURIComponent(identity.id)}`,
      message:
        c.provider === "telegram" ? `/start orc_${pairing.token}` : `orc-pair ${pairing.token}`,
    };
  }
  async confirmPairing(id: string) {
    const pairing = this.store.pairing(id);
    if (!pairing.candidate || pairing.confirmed)
      throw new ConflictError("Pairing is not ready or already confirmed");
    const c = this.connection(pairing.connection);
    if (!c.enabled || c.revision !== pairing.revision)
      throw new ConflictError("Connection changed; start a new pairing");
    const target = {
      id: "me",
      name: pairing.candidate.name,
      chat_id: pairing.candidate.chat_id,
      user_ids: [pairing.candidate.user_id],
      project_ids: [],
      inbound: false,
      outbound: true,
      attention: false,
    };
    this.store.db.transaction(() => {
      this.store.confirm(id);
      this.store.saveConnection({
        ...c,
        targets: [...c.targets.filter((t) => t.id !== "me"), target],
      });
    })();
    await this.reconcile();
    return target;
  }
  async receive(message: ChannelInbound): Promise<void> {
    const c = this.connection(message.connection);
    if (!c.enabled) return;
    const pairing =
      message.kind === "message" &&
      message.is_direct &&
      message.text.match(/^(?:\/start(?:@\w+)? orc_|orc-pair )([A-Za-z0-9_-]{32})$/);
    if (pairing) {
      this.store.offerPairing(c.id, pairing[1] as string, {
        chat_id: message.chat,
        user_id: message.sender,
        name: message.sender,
      });
      return;
    }
    const target = c.targets.find(
      (t) =>
        t.inbound &&
        t.chat_id === message.chat &&
        (!t.thread_id || t.thread_id === message.thread) &&
        t.user_ids.includes(message.sender),
    );
    if (!target || !message.message_id || !this.store.claim(c.id, message.message_id)) return;
    if (await this.control?.(message, target)) return;
    const route = routeMessage(c.routes, message);
    if (
      route?.action.type !== "agent" ||
      (target.project_ids.length && !target.project_ids.includes(route.action.project_id))
    )
      return;
    const key = JSON.stringify([c.id, message.chat, message.thread, message.sender, route.id]);
    const quotaKey = JSON.stringify([c.id, message.chat, message.sender]);
    let quota = this.quotas.get(quotaKey);
    if (!quota || quota.until <= Date.now()) {
      quota = { until: Date.now() + 60000, count: 0 };
      this.quotas.set(quotaKey, quota);
    }
    if (
      ++quota.count > 30 ||
      (this.pending.get(key) ?? 0) >= 10 ||
      this.pendingTotal >= 50 ||
      message.text.length > 100000
    ) {
      this.errors.set(
        c.id,
        "Inbound rate or queue limit reached. Wait before sending more messages.",
      );
      return;
    }
    this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
    this.pendingTotal++;
    const previous = this.turns.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        const current = this.connection(c.id);
        const recipient = current.targets.find(
          (t) =>
            t.id === target.id &&
            t.inbound &&
            t.chat_id === message.chat &&
            (!t.thread_id || t.thread_id === message.thread) &&
            t.user_ids.includes(message.sender),
        );
        const selected = routeMessage(current.routes, message);
        if (
          this.stopped ||
          !current.enabled ||
          !recipient ||
          selected?.id !== route.id ||
          selected.action.type !== "agent" ||
          fingerprint(selected.action) !== fingerprint(route.action) ||
          (recipient.project_ids.length &&
            !recipient.project_ids.includes(selected.action.project_id))
        )
          return;
        await this.handler?.(selected, message, recipient);
      });
    this.turns.set(key, next);
    try {
      await next;
    } finally {
      this.pendingTotal--;
      const count = (this.pending.get(key) ?? 1) - 1;
      if (count) this.pending.set(key, count);
      else this.pending.delete(key);
      if (this.turns.get(key) === next) this.turns.delete(key);
    }
  }
}

let service: ChannelService | undefined;
export function getChannelService() {
  service ??= new ChannelService(new ChannelStore(getSqlite()));
  return service;
}
