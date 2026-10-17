import { z } from "zod";

/** Query scope for project-or-global reads: a project id, or scope "global" for shared items. */
export const ScopeQuerySchema = z.object({
  project_id: z.string().min(1).max(200).optional(),
  scope: z.literal("global").optional(),
});
export type ScopeQuery = z.infer<typeof ScopeQuerySchema>;
