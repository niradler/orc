import { ChatModelSchema } from "@orc/core/chat";
import { agentLabel } from "@orc/core/coding-agents";
import { Check, ChevronDown, Settings, Star } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import type { AgentEffortChoice } from "@/lib/composer-chips";
import { cn } from "@/lib/utils";

const rowAction =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-highest hover:text-on-surface focus-visible:outline-2 focus-visible:outline-focus max-sm:size-11 pointer-coarse:size-11";

const rowHelp = cn(
  rowAction,
  "hidden size-6 max-[767px]:inline-flex pointer-coarse:inline-flex lg:size-6",
);

/** Full label, raw id and description of the selected model, for the chip's info
 *  popover and the picker's hover help. */
function ModelDetails({
  label,
  id,
  description,
  testId,
}: {
  label: string;
  id?: string;
  description?: string;
  testId?: string;
}) {
  return (
    <>
      <span className="block wrap-break-word" data-testid={testId}>
        {label}
      </span>
      {id && id !== label && (
        <span className="mt-0.5 block font-mono text-xs text-muted-foreground wrap-break-word">
          {id}
        </span>
      )}
      {description && (
        <span className="mt-1 block text-xs text-muted-foreground wrap-break-word">
          {description}
        </span>
      )}
    </>
  );
}

/** One model row: the provider's label only. The description it sends is help,
 *  not part of the name, so it lives behind the info button (and hover). */
function ModelRow({
  id,
  label,
  description,
  selected,
  disabled,
  testIdPrefix,
  onChoose,
  favorite,
  onFavorite,
}: {
  id: string;
  label: string;
  description?: string | undefined;
  selected: boolean;
  disabled: boolean;
  testIdPrefix: string;
  onChoose: (id: string) => void;
  favorite: boolean;
  onFavorite?: ((model: string) => void) | undefined;
}) {
  const [hovered, setHovered] = useState(false);
  const detailed = !!description;
  const row = (
    <div
      className="flex min-w-0 items-center"
      onPointerEnter={
        detailed
          ? (event) => {
              if (event.pointerType === "mouse") setHovered(true);
            }
          : undefined
      }
      onPointerLeave={detailed ? () => setHovered(false) : undefined}
    >
      <button
        type="button"
        role="menuitemradio"
        data-chip-option
        aria-checked={selected}
        aria-label={detailed ? `${label}. ${description}` : undefined}
        data-testid={
          id ? `${testIdPrefix}-model-option-${id}` : `${testIdPrefix}-model-option-default`
        }
        disabled={disabled}
        onClick={() => onChoose(id)}
        className={chipOption}
      >
        <span className="flex min-w-0 flex-1 flex-col py-1">
          <span
            data-chip-scroll
            data-testid={`${testIdPrefix}-model-label-${id || "default"}`}
            className="min-w-0 truncate"
          >
            {label}
          </span>
        </span>
        {selected && <Check size={14} aria-hidden="true" />}
      </button>
      {detailed && (
        <HelpPopover
          label={`${label} details`}
          testId={`${testIdPrefix}-model-help-${id || "default"}`}
          className={cn(rowHelp, "text-muted-foreground")}
          contentClassName="w-fit max-w-[min(20rem,calc(100vw-2rem))]"
        >
          <ModelDetails label={label} id={id} description={description} />
        </HelpPopover>
      )}
      {id && onFavorite && (
        <button
          type="button"
          data-testid={`${testIdPrefix}-model-favorite-${id}`}
          aria-pressed={favorite}
          aria-label={`Favorite ${label}`}
          title={favorite ? "Unpin" : "Pin to top"}
          onClick={() => onFavorite(id)}
          className={cn(rowAction, favorite && "text-warning")}
        >
          <Star size={14} aria-hidden="true" fill={favorite ? "currentColor" : "none"} />
        </button>
      )}
    </div>
  );
  if (!detailed) return row;
  return (
    <Tooltip open={hovered}>
      <TooltipTrigger asChild>{row}</TooltipTrigger>
      <TooltipContent
        side="right"
        align="center"
        data-testid={`${testIdPrefix}-model-tooltip-${id || "default"}`}
        className="max-w-[min(24rem,calc(100vw-1.5rem))]"
      >
        <ModelDetails label={label} id={id} description={description} />
      </TooltipContent>
    </Tooltip>
  );
}

export function AgentModelPicker({
  agent,
  selectedModel,
  agents,
  choices,
  descriptions,
  onAgent,
  onModel,
  hasEfforts,
  efforts,
  effort,
  onEffort,
  ready = true,
  streaming = false,
  modelsDisabled = false,
  fetching = false,
  warning,
  note,
  started = false,
  testIdPrefix = "chat",
  showAgent = false,
  providers,
  providerId,
  onProvider,
  agentName,
  accessibleSummary,
  favorites,
  onFavorite,
  onProviderSettings,
  footer,
}: {
  agent: string;
  selectedModel: string;
  agents: string[];
  choices: Map<string, string>;
  descriptions?: ReadonlyMap<string, string>;
  onAgent: (agent: string) => boolean;
  onModel: (model: string) => void;
  hasEfforts?: (model: string) => boolean;
  efforts?: AgentEffortChoice[] | undefined;
  effort?: string | undefined;
  onEffort?: ((value: string) => void) | undefined;
  ready?: boolean;
  streaming?: boolean;
  modelsDisabled?: boolean;
  fetching?: boolean;
  warning?: string | null | undefined;
  note?: string | undefined;
  started?: boolean;
  testIdPrefix?: string;
  /** Keep the agent name in the chip when nothing else in that surface names it
   *  (the job action form); the composer chip focuses on the model alone. */
  showAgent?: boolean;
  providers?: { id: string; name: string; agent: string }[];
  providerId?: string | undefined;
  onProvider?: (id: string) => boolean;
  agentName?: string | undefined;
  accessibleSummary?: string;
  favorites?: ReadonlySet<string>;
  onFavorite?: (model: string) => void;
  onProviderSettings?: (id: string) => void;
  footer?: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [model, setModel] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"agent" | "model" | "effort">("model");
  const phone = useMediaQuery("(max-width: 520px)");
  const agentList = useRef<HTMLDivElement>(null);
  const modelList = useRef<HTMLDivElement>(null);
  const effortList = useRef<HTMLDivElement>(null);
  const name = agentName ?? agentLabel(agent);
  const modelName = choices.get(selectedModel) || selectedModel || "Agent default";
  const effortChoices = efforts ?? [];
  const shown = tab === "effort" && !effortChoices.length ? "model" : tab;
  const effortLabel = effortChoices.find((choice) => choice.value === (effort ?? ""))?.label;
  const summary = effortLabel ? `${modelName} · ${effortLabel}` : modelName;
  const description = descriptions?.get(selectedModel);
  const modelRows = [["", "Agent default"] as const, ...choices]
    .filter(([id, label]) =>
      `${id} ${label} ${descriptions?.get(id) ?? ""}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
    )
    .sort(([a], [b]) => Number(!!favorites?.has(b)) - Number(!!favorites?.has(a)));
  function reset(): void {
    setCustom(false);
    setError("");
    setQuery("");
  }
  function chooseAgent(next: string): void {
    reset();
    if (onAgent(next)) setOpen(false);
    else showModels();
  }
  function showModels(): void {
    setTab("model");
    focusChipOption(modelList.current);
  }
  function chooseModel(next: string): void {
    onModel(next);
    reset();
    if (phone && hasEfforts?.(next)) setTab("effort");
    else setOpen(false);
  }
  function columns(event: KeyboardEvent<HTMLElement>): void {
    if (event.target instanceof HTMLInputElement) return;
    const target = event.target as Node;
    if (event.key === "ArrowRight" && agentList.current?.contains(target)) {
      event.preventDefault();
      focusChipOption(modelList.current);
    } else if (
      event.key === "ArrowRight" &&
      effortList.current &&
      modelList.current?.contains(target)
    ) {
      event.preventDefault();
      focusChipOption(effortList.current);
    } else if (event.key === "ArrowLeft" && effortList.current?.contains(target)) {
      event.preventDefault();
      focusChipOption(modelList.current);
    } else if (event.key === "ArrowLeft" && modelList.current?.contains(target)) {
      event.preventDefault();
      focusChipOption(agentList.current);
    }
  }
  const trigger = (
    <button
      type="button"
      data-chip-main
      data-testid={`${testIdPrefix}-agent-model-button`}
      aria-label={`Agent and model: ${name}, ${accessibleSummary ?? modelName}`}
      disabled={!ready}
      className="inline-flex min-w-0 flex-1 self-stretch items-center gap-1.5 focus-visible:outline-hidden"
    >
      <AgentIcon agent={agent} decorative size={14} />
      {showAgent && (
        <>
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
        </>
      )}
      <span
        data-chip-label
        data-chip-scroll
        data-testid={`${testIdPrefix}-model-current`}
        className="min-w-0 truncate"
      >
        {summary}
      </span>
      <ChevronDown
        data-chip-label
        size={12}
        aria-hidden="true"
        className={cn("shrink-0 opacity-60 transition-transform", open && "rotate-180")}
      />
    </button>
  );
  return (
    <span
      className={cn(
        composerChip,
        "max-w-[min(16rem,100%)] gap-1 text-on-surface max-[767px]:min-h-[46px] max-[767px]:min-w-[46px] pointer-coarse:min-h-[46px] pointer-coarse:min-w-[46px] any-pointer-coarse:min-h-[46px] any-pointer-coarse:min-w-[46px] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus has-[:disabled]:opacity-40 has-[[data-state=open]]:bg-surface-highest has-[[data-state=open]]:text-on-surface",
      )}
    >
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) setTab("model");
          else reset();
        }}
      >
        <TooltipProvider delayDuration={300}>
          <Tooltip open={open ? false : undefined}>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>{trigger}</PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              data-testid={`${testIdPrefix}-agent-model-tooltip`}
              className="max-w-[min(24rem,calc(100vw-1.5rem))]"
            >
              <span className="block text-xs text-muted-foreground">
                {name}
                {effortLabel ? ` · ${effortLabel} effort` : ""}
              </span>
              <span className="mt-0.5 block wrap-break-word text-xs">
                {accessibleSummary ?? modelName}
              </span>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <PopoverContent
          data-testid={`${testIdPrefix}-agent-model-picker`}
          aria-label="Choose agent and model"
          side="top"
          align="start"
          // The model help button sits in the chip, outside this content; using it
          // must not dismiss the open menu (which would unmount the button).
          onPointerDownOutside={(event) => {
            const target = event.detail.originalEvent.target;
            if (target instanceof HTMLElement && target.closest("[data-chip-help]")) {
              event.preventDefault();
            }
          }}
          onFocusOutside={(event) => {
            const target = event.detail.originalEvent.target;
            if (target instanceof HTMLElement && target.closest("[data-chip-help]")) {
              event.preventDefault();
            }
          }}
          className={cn(
            "max-h-[min(36rem,60vh)] max-w-[calc(100vw-1.5rem)] overflow-y-auto p-1.5",
            effortChoices.length ? "w-[36rem]" : "w-[28rem]",
          )}
          collisionPadding={12}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            focusChipOption(started || phone ? modelList.current : agentList.current);
          }}
          onKeyDown={columns}
        >
          {phone && (
            <Tabs value={shown} onValueChange={(value) => setTab(value as typeof tab)}>
              <TabsList
                aria-label="Agent, model and effort"
                className={cn(
                  "mb-1.5 grid w-full p-0",
                  effortChoices.length ? "grid-cols-3" : "grid-cols-2",
                )}
              >
                {(
                  [
                    ["agent", "Agent", name, name],
                    ["model", "Model", modelName, modelName],
                    ...(effortChoices.length
                      ? [
                          [
                            "effort",
                            "Effort",
                            effortLabel ?? "Default",
                            effortLabel ?? "Default",
                          ] as const,
                        ]
                      : []),
                  ] as const
                ).map(([value, kind, pick, full]) => (
                  <TabsTrigger
                    key={value}
                    value={value}
                    aria-label={`${kind}: ${full}`}
                    data-testid={`${testIdPrefix}-picker-tab-${value}`}
                    className="min-w-0 px-2"
                  >
                    <span className="truncate">{pick}</span>
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          )}
          <div
            className={cn(
              "grid gap-1.5 max-[520px]:grid-cols-1",
              effortChoices.length
                ? "grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_minmax(0,0.7fr)]"
                : "grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]",
            )}
          >
            <div
              ref={agentList}
              role="menu"
              aria-label="Agent"
              data-testid={`${testIdPrefix}-agent-select`}
              onKeyDown={onChipListKeyDown}
              className={cn(
                "min-w-0 border-border min-[521px]:border-r min-[521px]:pr-1.5",
                phone && shown !== "agent" && "hidden",
              )}
            >
              {!phone && <p className={chipHeading}>Agent</p>}
              {(providers?.length
                ? providers
                : agents.map((id) => ({ id, name: agentLabel(id), agent: id }))
              ).map((entry) => (
                <div key={entry.id} className="group flex min-w-0 items-center">
                  <button
                    type="button"
                    role="menuitemradio"
                    data-chip-option
                    aria-checked={entry.id === (providerId ?? agent)}
                    data-testid={
                      entry.id === entry.agent
                        ? `${testIdPrefix}-agent-option-${entry.id}`
                        : `${testIdPrefix}-provider-option-${entry.id}`
                    }
                    disabled={
                      !ready ||
                      (streaming && entry.agent === agent && entry.id !== (providerId ?? agent))
                    }
                    onClick={() => {
                      if (providers?.length && onProvider) {
                        reset();
                        if (onProvider(entry.id)) setOpen(false);
                        else showModels();
                      } else chooseAgent(entry.agent);
                    }}
                    className={chipOption}
                  >
                    <AgentIcon agent={entry.agent} decorative size={14} />
                    <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                    {entry.id === (providerId ?? agent) && <Check size={14} aria-hidden="true" />}
                  </button>
                  {onProviderSettings && (
                    <button
                      type="button"
                      data-testid={`${testIdPrefix}-provider-settings-${entry.id}`}
                      aria-label={`${entry.name} settings`}
                      title={`${entry.name} settings`}
                      onClick={() => {
                        setOpen(false);
                        onProviderSettings(entry.id);
                      }}
                      className={cn(
                        rowAction,
                        entry.id !== (providerId ?? agent) &&
                          "hidden group-focus-within:inline-flex group-hover:inline-flex max-sm:inline-flex pointer-coarse:inline-flex",
                      )}
                    >
                      <Settings size={14} aria-hidden="true" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div
              ref={modelList}
              role="menu"
              aria-label={`${name} model`}
              data-testid={`${testIdPrefix}-model-select`}
              onKeyDown={onChipListKeyDown}
              className={cn(
                "min-w-0",
                effortChoices.length && "border-border min-[521px]:border-r min-[521px]:pr-1.5",
                phone && shown !== "model" && "hidden",
              )}
            >
              {!phone && <p className={chipHeading}>Model</p>}
              {choices.size > 6 && (
                <Input
                  data-testid={`${testIdPrefix}-model-search`}
                  aria-label="Search models"
                  placeholder="Search models"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    const first = modelRows[0];
                    if (event.key === "Enter" && query.trim() && first && !modelsDisabled) {
                      event.preventDefault();
                      chooseModel(first[0]);
                    } else if (event.key === "ArrowDown") {
                      event.preventDefault();
                      focusChipOption(modelList.current, false);
                    }
                  }}
                  className="mb-1 min-w-0"
                />
              )}
              <div className="max-h-64 overflow-y-auto">
                {modelRows.length === 0 && (
                  <p className="px-2 py-1 text-xs text-muted-foreground">No models match</p>
                )}
                <TooltipProvider>
                  {modelRows.map(([id, label]) => (
                    <ModelRow
                      key={id || "default"}
                      id={id}
                      label={label}
                      description={descriptions?.get(id)}
                      selected={selectedModel === id}
                      disabled={modelsDisabled}
                      testIdPrefix={testIdPrefix}
                      onChoose={chooseModel}
                      favorite={!!favorites?.has(id)}
                      onFavorite={onFavorite}
                    />
                  ))}
                </TooltipProvider>
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
              {fetching && (
                <p className="px-2 py-1 text-xs text-muted-foreground">Loading models…</p>
              )}
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
            {effortChoices.length > 0 && (
              <div
                ref={effortList}
                role="menu"
                aria-label={`${name} effort`}
                data-testid={`${testIdPrefix}-effort-select`}
                onKeyDown={onChipListKeyDown}
                className={cn("min-w-0", phone && shown !== "effort" && "hidden")}
              >
                {!phone && <p className={chipHeading}>Effort</p>}
                <div className="max-h-64 overflow-y-auto">
                  {[{ value: "", label: "Default" }, ...effortChoices].map((choice) => (
                    <button
                      type="button"
                      key={choice.value || "default"}
                      role="menuitemradio"
                      data-chip-option
                      aria-checked={(effort ?? "") === choice.value}
                      data-testid={`${testIdPrefix}-effort-option-${choice.value || "default"}`}
                      disabled={modelsDisabled}
                      onClick={() => {
                        onEffort?.(choice.value);
                        if (phone) setOpen(false);
                      }}
                      className={chipOption}
                    >
                      <span className="min-w-0 flex-1 truncate">{choice.label}</span>
                      {(effort ?? "") === choice.value && <Check size={14} aria-hidden="true" />}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          {footer?.(() => setOpen(false))}
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
      {open && (
        <span data-chip-help className="inline-flex shrink-0 self-stretch">
          <HelpPopover
            label={`${name} model`}
            testId={`${testIdPrefix}-model-help`}
            className="h-full w-7 max-sm:w-11 pointer-coarse:w-11 lg:h-full lg:w-7 focus-visible:outline-hidden"
            contentClassName="w-fit max-w-[min(20rem,calc(100vw-2rem))]"
          >
            <span className="block text-xs text-muted-foreground">
              {name}
              {effortLabel ? ` · ${effortLabel} effort` : ""}
            </span>
            <ModelDetails
              label={modelName}
              id={selectedModel}
              description={description}
              testId={`${testIdPrefix}-model-help-name`}
            />
          </HelpPopover>
        </span>
      )}
    </span>
  );
}
