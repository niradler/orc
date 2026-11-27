import { z } from "zod";

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
export const TtlDaysSchema = z.coerce
  .number()
  .int()
  .min(0)
  .max(MAX_TTL_DAYS)
  .default(DEFAULT_TTL_DAYS);

/** Epoch milliseconds after which a soft-deleted row may be purged. */
export function ttlDeadline(ttlDays: number, now = new Date()): Date {
  return new Date(now.getTime() + ttlDays * 86_400_000);
}

/** Whole days left before a purge; 0 once due. Accepts a Date or an epoch-seconds value. */
export function ttlDaysLeft(deleteAfter: Date | number, now = new Date()): number {
  const at = deleteAfter instanceof Date ? deleteAfter.getTime() : deleteAfter * 1000;
  return Math.max(0, Math.ceil((at - now.getTime()) / 86_400_000));
}
