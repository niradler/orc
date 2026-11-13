import type { ParsedUsage } from "./usage-parsers.js";

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
  model?: string | null;
  tokensUsed?: number | null;
  tokensVersion?: number;
  tokens?: () => Promise<number | null>;
  usageVersion?: number;
  usage?: () => Promise<ParsedUsage>;
};

export type KnownSession = {
  lastActivityMs: number;
  tokensUsed: number | null;
  tokensVersion?: number;
  usageVersion?: number;
  session?: SessionRecord;
};

export type SessionAdapter = {
  backend: string;
  minIntervalMs: number;
  list(known: Map<string, KnownSession>): Promise<SessionRecord[]>;
};
