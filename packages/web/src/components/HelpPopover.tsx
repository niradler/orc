import { Portal } from "@radix-ui/react-tooltip";
import { Info } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export function HelpPopover({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openAtPointerDown = useRef(false);
  return (
    <TooltipProvider>
      <Tooltip open={open} onOpenChange={setOpen} delayDuration={150}>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 shrink-0 text-outline lg:size-8"
            aria-label={`About ${label}`}
            data-testid="view-help"
            onPointerDown={() => {
              openAtPointerDown.current = open;
            }}
            onClick={(event) => {
              event.preventDefault();
              setOpen(event.detail === 0 ? !open : !openAtPointerDown.current);
            }}
          >
            <Info aria-hidden />
          </Button>
        </TooltipTrigger>
        <Portal>
          <TooltipContent
            side="bottom"
            align="start"
            collisionPadding={16}
            className="w-80 max-w-[calc(100vw-2rem)] border-control-border bg-surface-high px-3 py-2.5 text-sm leading-relaxed"
            data-testid="view-help-content"
          >
            {children}
          </TooltipContent>
        </Portal>
      </Tooltip>
    </TooltipProvider>
  );
}
