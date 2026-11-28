import {
  forwardRef,
  type ReactNode,
  type TextareaHTMLAttributes,
  useId,
  useRef,
  useState,
} from "react";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type MarkdownFormFieldProps = Omit<
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

/**
 * A Markdown form value uses the same shared live-preview editor as documents. A visually hidden
 * native textarea keeps the form contract: required/validation, id and ref still work, and an
 * invalid submit reveals and focuses the editor instead of an invisible control.
 */
export const MarkdownFormField = forwardRef<HTMLTextAreaElement, MarkdownFormFieldProps>(
  function MarkdownFormField(
    {
      label,
      value,
      onChange,
      accessory,
      fill = false,
      className,
      id,
      disabled,
      readOnly,
      required,
      onInvalid,
      ...props
    },
    ref,
  ) {
    const generatedId = useId();
    const fieldId = id ?? generatedId;
    const testId = props["data-testid"];
    const [invalid, setInvalid] = useState(false);
    const [mode, setMode] = useState<"read" | "edit">("edit");
    const shell = useRef<HTMLDivElement>(null);
    const rows = typeof props.rows === "number" ? props.rows : 6;
    const height = fill ? undefined : Math.max(180, rows * 26 + 84);
    return (
      <div
        ref={shell}
        data-testid="markdown-field"
        className={cn(
          "flex min-w-0 flex-col gap-2",
          fill && "min-h-0 flex-1 overflow-hidden",
          className,
        )}
      >
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Label htmlFor={fieldId} className="text-sm text-muted-foreground">
            {label}
            {required ? " *" : ""}
          </Label>
          {accessory}
        </div>
        <textarea
          {...props}
          ref={ref}
          id={fieldId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          required={required}
          disabled={disabled}
          readOnly={readOnly}
          aria-hidden
          tabIndex={-1}
          data-testid={typeof testId === "string" ? `${testId}-native` : undefined}
          className="sr-only"
          onInvalid={(event) => {
            event.preventDefault();
            setInvalid(true);
            setMode("edit");
            requestAnimationFrame(() => {
              const content = shell.current?.querySelector<HTMLElement>('[contenteditable="true"]');
              content?.focus();
            });
            onInvalid?.(event);
          }}
        />
        <MarkdownEditor
          path={`${label || "field"}.md`}
          value={value}
          onChange={(next) => {
            if (invalid && next.trim()) setInvalid(false);
            onChange(next);
          }}
          readOnly={disabled || readOnly}
          testId={testId}
          label={typeof props["aria-label"] === "string" ? props["aria-label"] : label}
          placeholder={props.placeholder}
          initialMode="edit"
          mode={mode}
          onModeChange={(next) => setMode(next === "read" ? "read" : "edit")}
          layout="frame"
          fill={fill}
          compact
          height={height}
          className={cn(fill && "min-h-0 flex-1")}
          modeTestIdPrefix={typeof testId === "string" ? testId : undefined}
          previewTestId={typeof testId === "string" ? `${testId}-rendered` : undefined}
        />
        {invalid && (
          <p role="alert" className="text-xs text-error">
            {label} is required.
          </p>
        )}
      </div>
    );
  },
);
