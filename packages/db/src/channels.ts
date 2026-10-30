import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import {
  type ChannelConnection,
  ChannelConnectionSchema,
  type ChannelReceipt,
} from "@orc/core/channels";
import { ConflictError, NotFoundError } from "@orc/core/errors";
import { ulid } from "@orc/core/ids";

type ReceiptRow = { payload: string; request_hash: string; updated_at: number };
export type ChannelPairing = {
  id: string;
  connection: string;
  expires_at: number;
  candidate: { chat_id: string; user_id: string; name: string } | null;
  confirmed: boolean;
  revision: number;
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export class ChannelStore {
  constructor(
    readonly db: Database,
    private readonly now = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS channel_receipts (
      id TEXT PRIMARY KEY, connection TEXT NOT NULL, idem TEXT, request_hash TEXT NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(connection,idem));
      CREATE TABLE IF NOT EXISTS channel_pairings (id TEXT PRIMARY KEY, connection TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, expires_at INTEGER NOT NULL, candidate TEXT, confirmed INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS channel_leases (resource TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_inbound (connection TEXT NOT NULL, event_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(connection,event_id));`);
    db.exec(
      `CREATE TABLE IF NOT EXISTS channel_cursors (connection TEXT NOT NULL, account TEXT NOT NULL, cursor TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(connection,account))`,
    );
    db.exec(`CREATE TABLE IF NOT EXISTS channel_actions (
      id TEXT PRIMARY KEY, connection TEXT NOT NULL, target TEXT NOT NULL, chat TEXT NOT NULL, thread TEXT NOT NULL,
      users TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0)`);
    db.exec(`CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0, config TEXT NOT NULL, credentials TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_targets (
      channel_id TEXT NOT NULL REFERENCES channels(id), id TEXT NOT NULL, name TEXT NOT NULL, chat_id TEXT NOT NULL, thread_id TEXT,
      inbound INTEGER NOT NULL, outbound INTEGER NOT NULL, attention INTEGER NOT NULL, user_ids TEXT NOT NULL, project_ids TEXT NOT NULL, position INTEGER NOT NULL,
      PRIMARY KEY(channel_id,id));
      CREATE TABLE IF NOT EXISTS channel_routes (
      channel_id TEXT NOT NULL REFERENCES channels(id), id TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL, position INTEGER NOT NULL,
      condition TEXT NOT NULL, action TEXT NOT NULL, PRIMARY KEY(channel_id,id));
      CREATE INDEX IF NOT EXISTS channel_routes_order ON channel_routes(channel_id,position);`);
  }
  connections(): ChannelConnection[] {
    const rows = this.db
      .query<
        {
          id: string;
          name: string;
          provider: string;
          enabled: number;
          config: string;
          credentials: string;
          revision: number;
        },
        []
      >("SELECT * FROM channels ORDER BY created_at,id")
      .all();
    return rows.map((row) =>
      ChannelConnectionSchema.parse({
        id: row.id,
        name: row.name,
        provider: row.provider,
        revision: row.revision,
        enabled: !!row.enabled,
        config: JSON.parse(row.config),
        credentials: JSON.parse(row.credentials),
        targets: this.db
          .query<
            {
              id: string;
              name: string;
              chat_id: string;
              thread_id: string | null;
              inbound: number;
              outbound: number;
              attention: number;
              user_ids: string;
              project_ids: string;
            },
            [string]
          >("SELECT * FROM channel_targets WHERE channel_id=? ORDER BY position")
          .all(row.id)
          .map((t) => ({
            id: t.id,
            name: t.name,
            chat_id: t.chat_id,
            ...(t.thread_id ? { thread_id: t.thread_id } : {}),
            inbound: !!t.inbound,
            outbound: !!t.outbound,
            attention: !!t.attention,
            user_ids: JSON.parse(t.user_ids),
            project_ids: JSON.parse(t.project_ids),
          })),
        routes: this.db
          .query<
            { id: string; name: string; enabled: number; condition: string; action: string },
            [string]
          >("SELECT * FROM channel_routes WHERE channel_id=? ORDER BY position")
          .all(row.id)
          .map((r) => ({
            id: r.id,
            name: r.name,
            enabled: !!r.enabled,
            condition: JSON.parse(r.condition),
            action: JSON.parse(r.action),
          })),
      }),
    );
  }
  saveConnection(c: ChannelConnection): void {
    this.db
      .transaction(() => {
        const row = this.db
          .query<{ revision: number }, [string]>("SELECT revision FROM channels WHERE id=?")
          .get(c.id);
        if ((row?.revision ?? 0) !== c.revision)
          throw new ConflictError("Connection changed elsewhere. Reload before saving.");
        this.db
          .query(
            `INSERT INTO channels VALUES (?,?,?,?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,provider=excluded.provider,enabled=excluded.enabled,config=excluded.config,credentials=excluded.credentials,revision=channels.revision+1,updated_at=excluded.updated_at`,
          )
          .run(
            c.id,
            c.name,
            c.provider,
            c.enabled ? 1 : 0,
            JSON.stringify(c.config),
            JSON.stringify(c.credentials),
            this.now(),
            this.now(),
          );
        this.db.query("DELETE FROM channel_targets WHERE channel_id=?").run(c.id);
        this.db.query("DELETE FROM channel_routes WHERE channel_id=?").run(c.id);
        for (const [position, t] of c.targets.entries())
          this.db
            .query("INSERT INTO channel_targets VALUES (?,?,?,?,?,?,?,?,?,?,?)")
            .run(
              c.id,
              t.id,
              t.name,
              t.chat_id,
              t.thread_id ?? null,
              +t.inbound,
              +t.outbound,
              +t.attention,
              JSON.stringify(t.user_ids),
              JSON.stringify(t.project_ids),
              position,
            );
        for (const [position, r] of c.routes.entries())
          this.db
            .query("INSERT INTO channel_routes VALUES (?,?,?,?,?,?,?)")
            .run(
              c.id,
              r.id,
              r.name,
              +r.enabled,
              position,
              JSON.stringify(r.condition),
              JSON.stringify(r.action),
            );
      })
      .immediate();
  }
  reserve(
    connection: string,
    target: string,
    project: string | null,
    request: unknown,
    idem?: string,
    destination?: NonNullable<ChannelReceipt["destination"]>,
  ): { receipt: ChannelReceipt; fresh: boolean } {
    return this.db
      .transaction(() => {
        const requestHash = hash(JSON.stringify(request));
        const existing = idem
          ? this.db
              .query<ReceiptRow, [string, string]>(
                "SELECT payload,request_hash,updated_at FROM channel_receipts WHERE connection=? AND idem=?",
              )
              .get(connection, idem)
          : null;
        if (existing) {
          if (existing.request_hash !== requestHash)
            throw new ConflictError("Idempotency key already used with another message");
          const receipt: ChannelReceipt = JSON.parse(existing.payload);
          if (receipt.status === "sending" && existing.updated_at < this.now() - 120000) {
            receipt.status = "unknown";
            receipt.error =
              "Delivery interrupted; provider acceptance is unknown. Inspect before retrying.";
            this.save(receipt);
          }
          return { receipt, fresh: false };
        }
        const receipt: ChannelReceipt = {
          id: ulid(),
          connection,
          target,
          project_id: project,
          status: "sending",
          provider_ids: [],
          ...(destination ? { destination } : {}),
          error: null,
          created_at: this.now(),
        };
        this.db
          .query("INSERT INTO channel_receipts VALUES (?,?,?,?,?,?)")
          .run(
            receipt.id,
            connection,
            idem ?? null,
            requestHash,
            JSON.stringify(receipt),
            this.now(),
          );
        return { receipt, fresh: true };
      })
      .immediate();
  }
  save(receipt: ChannelReceipt) {
    this.db
      .query("UPDATE channel_receipts SET payload=?,updated_at=? WHERE id=?")
      .run(JSON.stringify(receipt), this.now(), receipt.id);
  }
  get(id: string): ChannelReceipt {
    const row = this.db
      .query<ReceiptRow, [string]>(
        "SELECT payload,request_hash,updated_at FROM channel_receipts WHERE id=?",
      )
      .get(id);
    if (!row) throw new NotFoundError("Channel receipt", id);
    const receipt: ChannelReceipt = JSON.parse(row.payload);
    if (receipt.status === "sending" && row.updated_at < this.now() - 120000) {
      receipt.status = "unknown";
      receipt.error = "Delivery interrupted; inspect before retrying.";
      this.save(receipt);
    }
    return receipt;
  }
  lease(resource: string, owner: string): boolean {
    return (
      this.db
        .query(
          `INSERT INTO channel_leases VALUES (?,?,?) ON CONFLICT(resource) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE owner=excluded.owner OR expires_at<=?`,
        )
        .run(resource, owner, this.now() + 45000, this.now()).changes > 0
    );
  }
  release(resource: string, owner: string) {
    this.db
      .query("UPDATE channel_leases SET expires_at=0 WHERE resource=? AND owner=?")
      .run(resource, owner);
  }
  cursor(connection: string, account: string): string | undefined {
    return this.db
      .query<{ cursor: string }, [string, string]>(
        "SELECT cursor FROM channel_cursors WHERE connection=? AND account=?",
      )
      .get(connection, account)?.cursor;
  }
  saveCursor(connection: string, account: string, cursor: string): void {
    this.db
      .query(
        "INSERT INTO channel_cursors VALUES (?,?,?,?) ON CONFLICT(connection,account) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at",
      )
      .run(connection, account, cursor, this.now());
  }
  claim(connection: string, id: string): boolean {
    return (
      this.db
        .query("INSERT OR IGNORE INTO channel_inbound VALUES (?,?,?)")
        .run(connection, id, this.now()).changes > 0
    );
  }
  createPairing(connection: string, revision = 0) {
    const id = ulid();
    const token = randomBytes(24).toString("base64url");
    const expires_at = this.now() + 600000;
    this.db
      .query(
        "INSERT INTO channel_pairings (id,connection,token_hash,expires_at,revision) VALUES (?,?,?,?,?)",
      )
      .run(id, connection, hash(token), expires_at, revision);
    return { id, token, expires_at };
  }
  offerPairing(
    connection: string,
    token: string,
    candidate: NonNullable<ChannelPairing["candidate"]>,
  ): boolean {
    return (
      this.db
        .query(
          "UPDATE channel_pairings SET candidate=? WHERE connection=? AND token_hash=? AND expires_at>? AND candidate IS NULL AND confirmed=0",
        )
        .run(JSON.stringify(candidate), connection, hash(token), this.now()).changes > 0
    );
  }
  pairing(id: string): ChannelPairing {
    const row = this.db
      .query<
        {
          id: string;
          connection: string;
          expires_at: number;
          candidate: string | null;
          confirmed: number;
          revision: number;
        },
        [string]
      >(
        "SELECT id,connection,expires_at,candidate,confirmed,revision FROM channel_pairings WHERE id=?",
      )
      .get(id);
    if (!row || row.expires_at <= this.now()) throw new NotFoundError("Active pairing", id);
    return {
      ...row,
      candidate: row.candidate ? JSON.parse(row.candidate) : null,
      confirmed: !!row.confirmed,
    };
  }
  confirm(id: string): ChannelPairing {
    const pairing = this.pairing(id);
    if (!pairing.candidate || pairing.confirmed)
      throw new ConflictError("Pairing is not ready or already confirmed");
    if (
      !this.db
        .query(
          "UPDATE channel_pairings SET confirmed=1 WHERE id=? AND confirmed=0 AND expires_at>?",
        )
        .run(id, this.now()).changes
    )
      throw new ConflictError("Pairing expired or already confirmed");
    return pairing;
  }
  action(
    connection: string,
    target: string,
    chat: string,
    thread: string | undefined,
    users: string[],
    value: string,
  ): string {
    const id = randomBytes(24).toString("base64url");
    this.db
      .query(
        "INSERT INTO channel_actions (id,connection,target,chat,thread,users,value,expires_at) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        connection,
        target,
        chat,
        thread ?? "",
        JSON.stringify(users),
        value,
        this.now() + 1800000,
      );
    return `orc_action:${id}`;
  }
  consumeAction(
    id: string,
    connection: string,
    target: string,
    chat: string,
    thread: string | undefined,
    user: string,
  ): string | null {
    return this.db
      .transaction(() => {
        const row = this.db
          .query<
            { users: string; value: string },
            [string, string, string, string, string, number]
          >(
            "SELECT users,value FROM channel_actions WHERE id=? AND connection=? AND target=? AND chat=? AND thread=? AND expires_at>? AND used=0",
          )
          .get(id, connection, target, chat, thread ?? "", this.now());
        if (!row || !(JSON.parse(row.users) as string[]).includes(user)) return null;
        this.db.query("UPDATE channel_actions SET used=1 WHERE id=?").run(id);
        return row.value;
      })
      .immediate();
  }
  prune() {
    const cutoff = this.now() - 30 * 86400000;
    this.db.query("DELETE FROM channel_receipts WHERE updated_at<?").run(cutoff);
    this.db.query("DELETE FROM channel_inbound WHERE created_at<?").run(cutoff);
    this.db.query("DELETE FROM channel_pairings WHERE expires_at<?").run(this.now() - 86400000);
    this.db.query("DELETE FROM channel_actions WHERE expires_at<?").run(this.now() - 86400000);
  }
}
