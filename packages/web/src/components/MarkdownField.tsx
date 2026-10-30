import { forwardRef, type ReactNode, type TextareaHTMLAttributes, useId, useState } from "react";
import { flushSync } from "react-dom";
import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type MarkdownFieldProps = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "value" | "onChange"
> & {
  label: string;
  value: string;
  onChange: (value: string) => void;
  accessory?: ReactNode;
  fill?: boolean;
  "data-testid"?: string;
};

/** A Markdown form value keeps native validation and its source mounted while previewing. */
export const MarkdownField = forwardRef<HTMLTextAreaElement, MarkdownFieldProps>(
  function MarkdownField(
    {
      label,
      value,
      onChange,
      accessory,
      fill = false,
      className,
      id,
      disabled,
      required,
      onInvalid,
      ...props
    },
    ref,
  ) {
    const generatedId = useId();
    const fieldId = id ?? generatedId;
    const [preview, setPreview] = useState(false);
    const testId = props["data-testid"];
    return (
      <div
        data-testid="markdown-field"
        className={cn("flex min-w-0 flex-col gap-2", fill && "min-h-0 flex-1", className)}
      >
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Label htmlFor={fieldId} className="text-sm text-muted-foreground">
            {label}
            {required ? " *" : ""}
          </Label>
          {accessory}
          <fieldset className="ml-auto flex items-center gap-1" aria-label="Markdown display mode">
            {([false, true] as const).map((mode) => (
              <Button
                key={String(mode)}
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                aria-pressed={preview === mode}
                data-testid={
                  typeof testId === "string" ? `${testId}-${mode ? "preview" : "edit"}` : undefined
                }
                className={cn("px-2", preview === mode && "bg-surface-highest text-on-surface")}
                onClick={() => setPreview(mode)}
              >
                {mode ? "Preview" : "Edit"}
              </Button>
            ))}
          </fieldset>
        </div>
        <Textarea
          {...props}
          ref={ref}
          id={fieldId}
          aria-label={props["aria-label"] ?? label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          required={required}
          rows={props.rows ?? 6}
          hidden={preview}
          className={cn(
            "bg-background font-body text-base sm:text-sm",
            fill ? "min-h-40 flex-1 resize-none" : "min-h-24",
            preview && "hidden",
          )}
          onInvalid={(event) => {
            // reportValidity must reveal the source before native validation tries to focus it.
            if (preview) flushSync(() => setPreview(false));
            onInvalid?.(event);
          }}
        />
        {preview && (
          <section
            aria-label="Rendered Markdown"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the rendered value is a keyboard-scrollable reading region.
            tabIndex={0}
            data-testid={typeof testId === "string" ? `${testId}-rendered` : undefined}
            className={cn(
              "min-w-0 overflow-auto rounded-md border border-control-border bg-background p-3 focus-visible:outline-2 focus-visible:outline-focus",
              fill ? "min-h-40 flex-1" : "min-h-24 max-h-80",
            )}
          >
            <Markdown readable>{value}</Markdown>
          </section>
        )}
      </div>
    );
  },
);
