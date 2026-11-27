import { z } from "zod";
import { ValidationError } from "./errors.js";

/**
 * Grace period between a recoverable delete and its permanent purge. Every resource
 * that archives on delete uses the same default so the behaviour is predictable.
 */
export const DEFAULT_TTL_DAYS = 30;
export const MAX_TTL_DAYS = 3650;

/**
 * Shared `ttl_days` value for scheduled deletes: whole days, default 30, where 0
 * means "delete permanently now". Also used as an MCP tool argument.
 */
export const TtlDaysSchema = z.preprocess(
  // An omitted or empty value means the default; only an explicit 0 deletes now.
  (value) => (value === null || value === "" ? undefined : value),
  z.coerce.number().int().min(0).max(MAX_TTL_DAYS).default(DEFAULT_TTL_DAYS),
);

/** Epoch milliseconds after which a soft-deleted row may be purged. */
export function ttlDeadline(ttlDays: number, now = new Date()): Date {
  return new Date(now.getTime() + ttlDays * 86_400_000);
}

const DURATION = /^(\d{1,6})\s*(s|m|h|d|w)$/i;
const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 };
export const MAX_TTL_SECONDS = MAX_TTL_DAYS * 86_400;

/** Parses `30m`, `12h`, `7d` or `4w` into seconds, bounded by MAX_TTL_DAYS. */
export function parseTtlSeconds(value: string): number {
  const match = DURATION.exec(value.trim());
  if (!match?.[1] || !match[2])
    throw new ValidationError("ttl must be a duration such as 30m, 12h, 7d or 4w");
  const seconds = Number(match[1]) * (UNIT_SECONDS[match[2].toLowerCase()] ?? 0);
  if (!Number.isSafeInteger(seconds) || seconds < 1)
    throw new ValidationError("ttl must be at least 1 second");
  if (seconds > MAX_TTL_SECONDS)
    throw new ValidationError(`ttl cannot exceed ${MAX_TTL_DAYS} days`);
  return seconds;
}

/** Whole days left before a purge; 0 once due. Accepts a Date or an epoch-seconds value. */
export function ttlDaysLeft(deleteAfter: Date | number, now = new Date()): number {
  const at = deleteAfter instanceof Date ? deleteAfter.getTime() : deleteAfter * 1000;
  return Math.max(0, Math.ceil((at - now.getTime()) / 86_400_000));
}
