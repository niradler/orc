import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as React from "react";
import { cn } from "@/lib/utils";

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;
const PopoverClose = PopoverPrimitive.Close;
const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> & { portalled?: boolean }
>(({ className, align = "center", sideOffset = 6, portalled = true, ...props }, ref) => {
  const content = (
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      collisionPadding={16}
      className={cn(
        "z-50 max-h-[var(--radix-popover-content-available-height)] max-w-[calc(100vw-2rem)] overflow-auto rounded-lg border border-control-border bg-surface-high p-3 text-on-surface shadow-lg outline-none",
        className,
      )}
      {...props}
    />
  );
  return portalled ? <PopoverPrimitive.Portal>{content}</PopoverPrimitive.Portal> : content;
});
PopoverContent.displayName = "PopoverContent";

export { Popover, PopoverAnchor, PopoverClose, PopoverContent, PopoverTrigger };
