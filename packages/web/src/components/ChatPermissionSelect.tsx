import type { ChatSettings } from "@orc/core/chat";
import { useAgentCapabilities } from "@/hooks/useAgentCapabilities";

export function ChatPermissionSelect({
  config,
  onChange,
  disabled = false,
}: {
  config: ChatSettings;
  onChange: (config: ChatSettings) => void;
  disabled?: boolean;
}) {
  const capabilities = useAgentCapabilities(config.agent);
  const supported = capabilities?.livePermissions === true;
  const agentOptions = config.agentOptions[config.agent];
  const sdkMode =
    agentOptions?.runtime === "claude-sdk" ? agentOptions.options.permissionMode : undefined;
  return (
    <label className="block space-y-2 text-sm">
      <span>Permissions</span>
      <select
        data-testid="chat-permission-mode"
        aria-label="Agent permissions"
        disabled={disabled || !supported}
        value={
          sdkMode ??
          config.permissionMode ??
          (config.autoApprove
            ? config.agent === "claude"
              ? "bypassPermissions"
              : "acceptEdits"
            : "default")
        }
        onChange={(event) => {
          const mode = event.target.value as NonNullable<ChatSettings["permissionMode"]>;
          onChange({
            ...config,
            permissionMode: mode,
            ...(agentOptions?.runtime === "claude-sdk" && sdkMode
              ? {
                  agentOptions: {
                    ...config.agentOptions,
                    [config.agent]: {
                      ...agentOptions,
                      options: { ...agentOptions.options, permissionMode: mode },
                    },
                  },
                }
              : {}),
          });
        }}
        className="min-h-8 w-full rounded-md border border-control-border bg-background px-3 text-base sm:text-sm disabled:opacity-50"
      >
        <option value="default">Ask in chat</option>
        <option value="acceptEdits">Allow workspace edits</option>
        <option value="bypassPermissions">Full access / bypass permissions</option>
      </select>
      <span className="block text-xs text-muted-foreground">
        {!supported
          ? "This backend does not expose live permission modes. ACP approvals appear individually; ACPX uses Advanced launch options."
          : (sdkMode ?? config.permissionMode) === "bypassPermissions" ||
              (!config.permissionMode && config.autoApprove && config.agent === "claude")
            ? "Allows actions without permission prompts. Codex also runs without a sandbox. Workspace rules still apply."
            : "Ask in chat keeps approval prompts. Workspace edits allow changes within the agent’s workspace policy."}
      </span>
    </label>
  );
}
