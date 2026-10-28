import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

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
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        data-ui="button"
        data-variant={variant ?? "default"}
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
