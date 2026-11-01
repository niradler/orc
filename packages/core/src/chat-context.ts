import { z } from "zod";

/** Wrapper for per-turn context ORC gives the agent. Chat and transcript views hide it. */
export const ORC_CONTEXT_TAG = "orc-context";

export const ChatTurnContextSchema = z
  .object({
    source: z.literal("webchat"),
    // Dashboard path the user is looking at, e.g. /tasks/<id>.
    route: z
      .string()
      .max(2000)
      .regex(/^\/(?!\/)/)
      .optional(),
  })
  .strict();
export type ChatTurnContext = z.infer<typeof ChatTurnContextSchema>;

const MAX_VALUE = 500;

// One line per value and no markup, so a value can never close the block early.
function clean(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, MAX_VALUE);
}

/** Formats `key: value` lines inside an <orc-context> block; empty values are skipped. */
export function formatOrcContext(
  fields: Record<string, string | number | null | undefined>,
): string {
  const lines = Object.entries(fields)
    .filter((entry): entry is [string, string | number] => entry[1] != null && entry[1] !== "")
    .map(([key, value]) => `${clean(key)}: ${clean(String(value))}`);
  return `<${ORC_CONTEXT_TAG}>\n${lines.join("\n")}\n</${ORC_CONTEXT_TAG}>`;
}

/** Prepends context to the prompt sent to the agent. History keeps the user's own text. */
export function withOrcContext(
  prompt: string,
  fields: Record<string, string | number | null | undefined>,
): string {
  return `${formatOrcContext(fields)}\n\n${prompt}`;
}
