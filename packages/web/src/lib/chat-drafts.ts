import { ChatSettingsSchema, ChatWorkspaceSchema } from "@orc/core/chat";
import { z } from "zod";

export const CHAT_DRAFTS_KEY = "orc_chat_drafts";
export const CHAT_DRAFT_ACTIVE_KEY = "orc_chat_draft_active";
const DraftSchema = z.object({
  key: z.string().uuid(),
  threadId: z.string().uuid().nullable(),
  projectId: z.string().max(100).nullable().optional(),
  draft: z.string().max(1_000_000),
  config: ChatSettingsSchema,
  workspace: ChatWorkspaceSchema.optional(),
  hidden: z.boolean().optional(),
});
export type SavedChatDraft = z.infer<typeof DraftSchema>;

export function parseChatDrafts(raw: string | null): SavedChatDraft[] {
  try {
    if (!raw || raw.length > 5_000_000) return [];
    const result = z.array(DraftSchema).max(50).safeParse(JSON.parse(raw));
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}
