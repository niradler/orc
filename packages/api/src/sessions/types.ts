export type SessionStatus = "running" | "idle" | "stopped";

export type SessionRecord = {
  backend: string;
  externalId: string;
  title: string;
  summary?: string | null;
  cwd?: string | null;
  status: SessionStatus;
  pid?: number | null;
  createdAt: Date;
  lastActivityAt: Date;
  transcriptPath?: string | null;
  tokensUsed?: number | null;
  tokens?: () => Promise<number | null>;
};

export type KnownSession = { lastActivityMs: number; tokensUsed: number | null };

export type SessionAdapter = {
  backend: string;
  minIntervalMs: number;
  list(known: Map<string, KnownSession>): Promise<SessionRecord[]>;
};
