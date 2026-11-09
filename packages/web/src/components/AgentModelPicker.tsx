import { ChatModelSchema } from "@orc/core/chat";
import { agentLabel } from "@orc/core/coding-agents";
import { Check, ChevronDown } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";
import { AgentIcon } from "@/components/AgentIcon";
import {
  chipHeading,
  chipOption,
  composerChip,
  focusChipOption,
  onChipListKeyDown,
} from "@/components/ComposerChip";
import { HelpPopover } from "@/components/HelpPopover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export function AgentModelPicker({
  agent,
  selectedModel,
  agents,
  choices,
  onAgent,
  onModel,
  ready = true,
  streaming = false,
  modelsDisabled = false,
  fetching = false,
  warning,
  summary: suppliedSummary,
  note,
  started = false,
  testIdPrefix = "chat",
  providers,
  providerId,
  onProvider,
  agentName,
  accessibleSummary,
}: {
  agent: string;
  selectedModel: string;
  agents: string[];
  choices: Map<string, string>;
  onAgent: (agent: string) => boolean;
  onModel: (model: string) => void;
  ready?: boolean;
  streaming?: boolean;
  modelsDisabled?: boolean;
  fetching?: boolean;
  warning?: string | null | undefined;
  summary?: string;
  note?: string | undefined;
  started?: boolean;
  testIdPrefix?: string;
  providers?: { id: string; name: string; agent: string }[];
  providerId?: string | undefined;
  onProvider?: (id: string) => boolean;
  agentName?: string | undefined;
  accessibleSummary?: string;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [model, setModel] = useState("");
  const [error, setError] = useState("");
  const agentList = useRef<HTMLDivElement>(null);
  const modelList = useRef<HTMLDivElement>(null);
  const name = agentName ?? agentLabel(agent);
  const modelName = choices.get(selectedModel) || selectedModel || "Agent default";
  const summary = suppliedSummary ?? modelName;
  function reset(): void {
    setCustom(false);
    setError("");
  }
  function chooseAgent(next: string): void {
    reset();
    if (onAgent(next)) setOpen(false);
    else focusChipOption(modelList.current);
  }
  function chooseModel(next: string): void {
    onModel(next);
    setOpen(false);
  }
  function columns(event: KeyboardEvent<HTMLElement>): void {
    if (event.target instanceof HTMLInputElement) return;
    if (event.key === "ArrowRight" && agentList.current?.contains(event.target as Node)) {
      event.preventDefault();
      focusChipOption(modelList.current);
    } else if (event.key === "ArrowLeft" && modelList.current?.contains(event.target as Node)) {
      event.preventDefault();
      focusChipOption(agentList.current);
    }
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={`${testIdPrefix}-agent-model-button`}
          aria-label={`Agent and model: ${name}, ${accessibleSummary ?? summary}`}
          title={`${name} · ${summary}`}
          disabled={!ready}
          className={cn(composerChip, "max-w-64 text-on-surface")}
        >
          <AgentIcon agent={agent} decorative size={14} />
          <span
            data-chip-label
            data-testid={`${testIdPrefix}-agent-current`}
            className="min-w-0 max-w-32 truncate"
          >
            {name}
          </span>
          <span data-chip-label aria-hidden="true" className="text-muted-foreground">
            ·
          </span>
          <span
            data-chip-label
            data-testid={`${testIdPrefix}-model-current`}
            className="min-w-0 truncate"
          >
            {summary}
          </span>
          <ChevronDown
            data-chip-label
            size={12}
            aria-hidden="true"
            className="shrink-0 opacity-60"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        data-testid={`${testIdPrefix}-agent-model-picker`}
        aria-label="Choose agent and model"
        side="top"
        align="start"
        className="w-[26rem] max-w-[calc(100vw-2rem)] p-1.5"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          focusChipOption(started ? modelList.current : agentList.current);
        }}
        onKeyDown={columns}
      >
        <div className="grid grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] gap-1.5 max-[420px]:grid-cols-1">
          <div
            ref={agentList}
            role="menu"
            aria-label="Agent"
            data-testid={`${testIdPrefix}-agent-select`}
            onKeyDown={onChipListKeyDown}
            className="min-w-0 border-border max-[420px]:border-b max-[420px]:pb-1.5 min-[421px]:border-r min-[421px]:pr-1.5"
          >
            <p className={chipHeading}>Agent</p>
            {(providers?.length
              ? providers
              : agents.map((id) => ({ id, name: agentLabel(id), agent: id }))
            ).map((entry) => (
              <button
                type="button"
                key={entry.id}
                role="menuitemradio"
                data-chip-option
                aria-checked={entry.id === (providerId ?? agent)}
                data-testid={
                  entry.id === entry.agent
                    ? `${testIdPrefix}-agent-option-${entry.id}`
                    : `${testIdPrefix}-provider-option-${entry.id}`
                }
                disabled={!ready}
                onClick={() => {
                  if (providers?.length && onProvider) {
                    reset();
                    if (onProvider(entry.id)) setOpen(false);
                    else focusChipOption(modelList.current);
                  } else chooseAgent(entry.agent);
                }}
                className={chipOption}
              >
                <AgentIcon agent={entry.agent} decorative size={14} />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {entry.id === (providerId ?? agent) && <Check size={14} aria-hidden="true" />}
              </button>
            ))}
          </div>
          <div
            ref={modelList}
            role="menu"
            aria-label={`${name} model`}
            data-testid={`${testIdPrefix}-model-select`}
            onKeyDown={onChipListKeyDown}
            className="min-w-0"
          >
            <p className={chipHeading}>Model</p>
            <div className="max-h-64 overflow-y-auto">
              {[["", "Agent default"] as const, ...choices].map(([id, label]) => (
                <button
                  type="button"
                  key={id || "default"}
                  role="menuitemradio"
                  data-chip-option
                  aria-checked={selectedModel === id}
                  data-testid={
                    id
                      ? `${testIdPrefix}-model-option-${id}`
                      : `${testIdPrefix}-model-option-default`
                  }
                  disabled={modelsDisabled}
                  onClick={() => chooseModel(id)}
                  className={chipOption}
                >
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  {selectedModel === id && <Check size={14} aria-hidden="true" />}
                </button>
              ))}
            </div>
            {custom ? (
              <form
                className="flex min-w-0 gap-1 px-1 py-1"
                onSubmit={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  const parsed = ChatModelSchema.safeParse(model);
                  if (!parsed.success) {
                    setError("Enter a valid model ID (up to 200 characters).");
                    return;
                  }
                  chooseModel(parsed.data);
                }}
              >
                <Input
                  data-testid={`${testIdPrefix}-custom-model`}
                  aria-label="Custom model ID"
                  autoFocus
                  value={model}
                  disabled={streaming}
                  onChange={(event) => setModel(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    event.stopPropagation();
                    reset();
                  }}
                  className="min-w-0"
                />
                <Button
                  type="submit"
                  data-testid={`${testIdPrefix}-custom-model-apply`}
                  disabled={streaming}
                  className="min-h-8 px-2"
                >
                  Use
                </Button>
              </form>
            ) : (
              <button
                type="button"
                data-chip-option
                data-testid={`${testIdPrefix}-model-option-custom`}
                disabled={modelsDisabled}
                onClick={() => {
                  setModel(selectedModel);
                  setError("");
                  setCustom(true);
                }}
                className={cn(chipOption, "text-on-surface-variant")}
              >
                Custom model…
              </button>
            )}
            {error && (
              <p role="alert" className="px-2 py-1 text-xs text-error wrap-break-word">
                {error}
              </p>
            )}
            {fetching && <p className="px-2 py-1 text-xs text-muted-foreground">Loading models…</p>}
            {warning && (
              <p
                data-testid={`${testIdPrefix}-model-warning`}
                role="status"
                className="px-2 py-1 text-xs text-muted-foreground wrap-break-word"
              >
                {warning}
              </p>
            )}
          </div>
        </div>
        {note && (
          <div className="mt-1.5 flex items-center gap-1 border-t border-border px-2 pt-1.5 text-xs text-muted-foreground">
            Selection guidance
            <HelpPopover
              label="Agent and model selection"
              testId={`${testIdPrefix}-agent-model-help`}
            >
              <span data-testid={`${testIdPrefix}-agent-model-note`}>{note}</span>
            </HelpPopover>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
