import type { SelectHTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import "./TerminalControls.css";

export function TerminalSelect({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="terminal-select-wrap">
      <select {...props} className={cn("terminal-select", className)}>
        {children}
      </select>
    </span>
  );
}
