import type { ChatSettings } from "@orc/core/chat";
import { Check, ChevronDown, ShieldAlert, ShieldCheck } from "lucide-react";
import { useRef, useState } from "react";
import {
  chipHeading,
  chipOption,
  composerChip,
  focusChipOption,
  onChipListKeyDown,
} from "@/components/ComposerChip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useChat } from "@/hooks/useChat";
import {
  effectivePermissionMode,
  PERMISSION_LABELS,
  type PermissionMode,
  permissionSupported,
  withPermissionMode,
} from "@/lib/composer-chips";
import { cn } from "@/lib/utils";

export function ChatPermissionSelect({
  config,
  onChange,
  disabled = false,
}: {
  config: ChatSettings;
  onChange: (config: ChatSettings) => void;
  disabled?: boolean;
}) {
  const supported = permissionSupported(config.agent);
  const mode = effectivePermissionMode(config);
  return (
    <label className="block space-y-2 text-sm">
      <span>Permissions</span>
      <select
        data-testid="chat-permission-mode"
        aria-label="Agent permissions"
        disabled={disabled || !supported}
        value={mode}
        onChange={(event) =>
          onChange(withPermissionMode(config, event.target.value as PermissionMode))
        }
        className="min-h-8 w-full rounded-md border border-control-border bg-background px-3 text-base sm:text-sm disabled:opacity-50"
      >
        <option value="default">Ask in chat</option>
        <option value="acceptEdits">Allow workspace edits</option>
        <option value="bypassPermissions">Full access / bypass permissions</option>
      </select>
      <span className="block text-xs text-muted-foreground">
        {!supported
          ? "Set ACPX permission flags under Advanced launch options in Session settings."
          : mode === "bypassPermissions"
            ? "Allows actions without permission prompts. Codex also runs without a sandbox. Workspace rules still apply."
            : "Ask in chat keeps approval prompts. Workspace edits allow changes within the agent’s workspace policy."}
      </span>
    </label>
  );
}

export function ChatPermissionChip() {
  const { config, changePermissions, ready } = useChat();
  const [open, setOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const mode = effectivePermissionMode(config);
  if (!permissionSupported(config.agent) || mode === "default") return null;
  const Icon = mode === "bypassPermissions" ? ShieldAlert : ShieldCheck;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="chat-permission-chip"
          data-mode={mode}
          aria-label={`Permissions: ${PERMISSION_LABELS[mode]}`}
          title={`Permissions: ${PERMISSION_LABELS[mode]}`}
          disabled={!ready}
          className={cn(composerChip, mode === "bypassPermissions" && "text-warning")}
        >
          <Icon size={14} aria-hidden="true" />
          <span className="truncate">{PERMISSION_LABELS[mode]}</span>
          <ChevronDown size={12} aria-hidden="true" className="shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        aria-label="Permissions"
        className="w-64 p-1.5"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          focusChipOption(list.current);
        }}
      >
        <div ref={list} role="menu" aria-label="Permissions" onKeyDown={onChipListKeyDown}>
          <p className={chipHeading}>Permissions</p>
          {(Object.keys(PERMISSION_LABELS) as PermissionMode[]).map((option) => (
            <button
              type="button"
              key={option}
              role="menuitemradio"
              data-chip-option
              aria-checked={option === mode}
              data-testid={`chat-permission-option-${option}`}
              onClick={() => {
                setOpen(false);
                void changePermissions(withPermissionMode(config, option));
              }}
              className={chipOption}
            >
              <span className="min-w-0 flex-1 truncate">{PERMISSION_LABELS[option]}</span>
              {option === mode && <Check size={14} aria-hidden="true" />}
            </button>
          ))}
          <p className="px-2 pt-1 text-xs text-muted-foreground">
            Loosening applies right away; stricter permissions apply to your next message.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
