export type SessionStatus = "running" | "idle" | "stopped";

export type SessionRecord = {
  backend: string;
  externalId: string;
  title: string;
  summary?: string | null;
  cwd?: string | null;
  status: SessionStatus;
  pendingHuman?: boolean;
  pid?: number | null;
  createdAt: Date;
  lastActivityAt: Date;
  transcriptPath?: string | null;
  tokensUsed?: number | null;
  tokensVersion?: number;
  tokens?: () => Promise<number | null>;
};

export type KnownSession = {
  lastActivityMs: number;
  tokensUsed: number | null;
  tokensVersion?: number;
  session?: SessionRecord;
};

export type SessionAdapter = {
  backend: string;
  minIntervalMs: number;
  list(known: Map<string, KnownSession>): Promise<SessionRecord[]>;
};
