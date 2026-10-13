import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";

const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;
const SheetPortal = DialogPrimitive.Portal;

const SheetOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
SheetOverlay.displayName = "SheetOverlay";

const SheetContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    side?: "right" | "left";
  }
>(({ className, children, side = "right", ...props }, ref) => (
  <SheetPortal>
    <SheetOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed z-50 flex flex-col bg-surface border-l border-surface-highest shadow-lg",
        "inset-y-0 h-full w-[480px] max-w-[90vw]",
        "data-[state=open]:animate-in data-[state=closed]:animate-out",
        side === "right"
          ? "right-0 data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right"
          : "left-0 data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left",
        "duration-200",
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close
        className="absolute right-1 top-1 flex size-11 items-center justify-center text-outline hover:text-on-surface transition-colors"
        aria-label="Close panel"
      >
        <X size={16} />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </SheetPortal>
));
SheetContent.displayName = "SheetContent";

function SheetHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("pl-4 pr-14 py-4 sm:pl-6 border-b border-surface-highest shrink-0", className)}
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <DialogPrimitive.Title asChild>
      <h3
        className={cn("font-headline text-sm uppercase tracking-widest text-on-surface", className)}
        {...props}
      />
    </DialogPrimitive.Title>
  );
}

function SheetDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("font-body text-xs text-outline mt-1", className)} {...props} />;
}

function SheetBody({ className, ...props }: React.ComponentPropsWithRef<"div">) {
  return <div className={cn("flex-1 overflow-y-auto px-4 sm:px-6 py-4", className)} {...props} />;
}

function SheetFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "px-6 py-4 border-t border-surface-highest shrink-0 flex justify-end gap-2",
        className,
      )}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetOverlay,
  SheetTitle,
  SheetTrigger,
};
