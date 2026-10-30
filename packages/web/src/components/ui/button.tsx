import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { ActionHelp } from "@/components/ActionHelp";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0  ",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90   ",
        destructive: "bg-error text-primary-foreground hover:bg-error/90   ",
        outline:
          "border border-control-border bg-transparent hover:bg-surface hover:text-foreground    ",
        secondary: "bg-muted text-foreground hover:bg-muted/80   ",
        ghost: "hover:bg-surface hover:text-foreground  ",
        link: "text-foreground underline-offset-4 hover:underline ",
      },
      size: {
        default: "h-8 px-3 text-[13px]",
        sm: "h-8 rounded-md px-2.5 text-[13px]",
        lg: "h-10 rounded-md px-5",
        icon: "h-8 w-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /** Disable when an existing explanation popover already owns this icon. */
  actionHelp?: boolean;
}

function hasVisibleText(children: React.ReactNode): boolean {
  return React.Children.toArray(children).some((child) => {
    if (typeof child === "string") return Boolean(child.trim());
    if (typeof child === "number") return true;
    if (
      !React.isValidElement<{
        children?: React.ReactNode;
        className?: string;
        "aria-hidden"?: boolean | "true" | "false";
      }>(child)
    )
      return false;
    if (
      child.type === "svg" ||
      child.props["aria-hidden"] === true ||
      child.props["aria-hidden"] === "true" ||
      /\bsr-only\b/.test(child.props.className ?? "")
    )
      return false;
    return hasVisibleText(child.props.children);
  });
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, actionHelp = true, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    const label = props.title || props["aria-label"];
    const explained =
      actionHelp && Boolean(label) && (size === "icon" || !hasVisibleText(props.children));
    const button = (
      <Comp
        data-ui="button"
        data-variant={variant ?? "default"}
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
        aria-label={props["aria-label"] || (explained ? label : undefined)}
        title={explained ? undefined : props.title}
      />
    );
    return explained && label ? (
      <ActionHelp label={label} touchHelp={!props["aria-haspopup"]}>
        {button}
      </ActionHelp>
    ) : (
      button
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
