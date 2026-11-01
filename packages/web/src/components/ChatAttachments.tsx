import { SessionFileSchema } from "@orc/core/session-file-types";
import { Paperclip } from "lucide-react";

export function ChatAttachments({ value }: { value: unknown }) {
  const parsed = SessionFileSchema.array().safeParse(value);
  if (!parsed.success || !parsed.data.length) return null;
  return (
    <ul data-testid="chat-message-attachments" className="mb-2 flex flex-wrap gap-2">
      {parsed.data.map((file) => (
        <li
          key={file.id}
          title={file.path}
          className="flex min-w-0 max-w-full items-center gap-1 rounded border border-border px-2 py-1 text-xs"
        >
          <Paperclip size={12} className="shrink-0" />
          <span className="truncate">{file.name}</span>
        </li>
      ))}
    </ul>
  );
}
