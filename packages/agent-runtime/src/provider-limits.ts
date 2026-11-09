import { z } from "zod";
import type { AgentEvent } from "./types.js";

const ResetSchema = z.number().finite().nonnegative().max(253402300799).optional();
const ClaudeLimitSchema = z.object({
  status: z.enum(["allowed", "allowed_warning", "rejected"]),
  resetsAt: ResetSchema,
  overageStatus: z.enum(["allowed", "allowed_warning", "rejected"]).optional(),
  isUsingOverage: z.boolean().optional(),
  overageInUse: z.boolean().optional(),
});
const CodexWindowSchema = z.object({
  usedPercent: z.number().finite().min(0).max(100),
  resetsAt: ResetSchema.nullable(),
});
const CodexLimitSchema = z.object({
  primary: CodexWindowSchema.nullish(),
  secondary: CodexWindowSchema.nullish(),
});

function resetMessage(seconds: number | undefined | null): string {
  return seconds === undefined || seconds === null
    ? " Reset time unavailable."
    : ` Resets ${new Date(seconds * 1000).toISOString()}.`;
}

export function claudeLimitEvent(value: unknown): AgentEvent | null {
  const parsed = ClaudeLimitSchema.safeParse(value);
  if (!parsed.success || parsed.data.status === "allowed") return null;
  const limit = parsed.data;
  const overage =
    limit.isUsingOverage ||
    limit.overageInUse ||
    limit.overageStatus === "allowed" ||
    limit.overageStatus === "allowed_warning";
  if (limit.status === "rejected" && !overage)
    return {
      type: "error",
      data: `Claude usage limit reached.${resetMessage(limit.resetsAt)} Retry after the limit resets.`,
    };
  return {
    type: "system_status",
    data: `Claude usage limit ${overage ? "reached; extra usage is available" : "approaching"}.${resetMessage(limit.resetsAt)}`,
  };
}

export function codexLimitEvent(value: unknown): AgentEvent | null {
  const parsed = CodexLimitSchema.safeParse(value);
  if (!parsed.success) return null;
  const windows = [parsed.data.primary, parsed.data.secondary].filter(
    (window) => window && window.usedPercent >= 90,
  );
  if (!windows.length) return null;
  return {
    type: "system_status",
    data: windows
      .map(
        (window) => `Codex usage: ${window?.usedPercent}% used.${resetMessage(window?.resetsAt)}`,
      )
      .join("\n"),
  };
}
