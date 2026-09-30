import { Check, Copy } from "lucide-react";
import { useState } from "react";
import type { LiveSession } from "@/api/client";
import { resumeCommand } from "@/lib/live-sessions";

export function CopyResume({ session }: { session: LiveSession }) {
  const [copied, setCopied] = useState(false);
  const command = resumeCommand(session);
  if (!command) return null;
  return (
    <button
      type="button"
      data-testid="copy-resume"
      title={command}
      className="inline-flex items-center gap-1 font-label text-[11px] uppercase tracking-widest text-primary hover:text-on-surface"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(command).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : "Resume"}
    </button>
  );
}
