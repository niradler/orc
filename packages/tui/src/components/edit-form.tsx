import { useTerminalDimensions } from "@opentui/react";
import { createLogger } from "@orc/core/logger";
import { useCallback, useMemo, useRef, useState } from "react";
import { colors } from "../theme.js";
import { getScreenSize, type KeyEvent, type SelectOption } from "../types.js";

const logger = createLogger("tui:form");

export type FormFieldType = "input" | "textarea" | "select";

export type FormField = {
  key: string;
  label: string;
  value: string;
  type?: FormFieldType;
  placeholder?: string;
  description?: string;
  height?: number;
  options?: SelectOption[];
};

export type FormResult = {
  submitted: boolean;
  values: Record<string, string>;
};

export type FormSubmitState = {
  status: "idle" | "saving" | "success" | "error";
  message: string | null;
};

const IDLE_SUBMIT_STATE: FormSubmitState = {
  status: "idle",
  message: null,
};

export function isSaveKey(key: KeyEvent): boolean {
  return (
    ((key.ctrl || key.meta || key.option) && key.name === "s") ||
    key.sequence === "\u0013" ||
    key.name === "f2"
  );
}

export function formErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object") {
    const maybeRecord = error as Record<string, unknown>;
    const directMessage = maybeRecord.error ?? maybeRecord.message ?? maybeRecord.detail;
    if (typeof directMessage === "string" && directMessage) return directMessage;
    if (directMessage && typeof directMessage === "object") {
      const nested = formErrorMessage(directMessage, fallback);
      if (nested !== fallback) return nested;
    }

    const issues = maybeRecord.issues;
    if (Array.isArray(issues) && issues.length > 0) {
      const firstIssue = issues[0];
      if (typeof firstIssue === "string" && firstIssue) return firstIssue;
      if (firstIssue && typeof firstIssue === "object") {
        const nested = formErrorMessage(firstIssue, fallback);
        if (nested !== fallback) return nested;
      }
    }

    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== "{}") return serialized;
    } catch {
      // Ignore serialization errors and fall through to the fallback.
    }
  }
  return fallback;
}

export function useEditForm() {
  const [active, setActive] = useState(false);
  const [fields, setFields] = useState<FormField[]>([]);
  const [focusIdx, setFocusIdx] = useState(0);
  const [submitState, setSubmitState] = useState<FormSubmitState>(IDLE_SUBMIT_STATE);
  const isSubmittingRef = useRef(false);

  const open = useCallback((newFields: FormField[]) => {
    setFields(newFields);
    setFocusIdx(0);
    setSubmitState(IDLE_SUBMIT_STATE);
    setActive(true);
  }, []);

  const close = useCallback(() => {
    setSubmitState(IDLE_SUBMIT_STATE);
    setActive(false);
  }, []);

  const updateValue = useCallback((key: string, value: string) => {
    setFields((current) =>
      current.map((field) => (field.key === key ? { ...field, value } : field)),
    );
  }, []);

  const nextField = useCallback(() => {
    setFocusIdx((current) => {
      if (fields.length === 0) return 0;
      return (current + 1) % fields.length;
    });
  }, [fields.length]);

  const prevField = useCallback(() => {
    setFocusIdx((current) => {
      if (fields.length === 0) return 0;
      return (current - 1 + fields.length) % fields.length;
    });
  }, [fields.length]);

  const getValues = useCallback(() => {
    const values: Record<string, string> = {};
    for (const field of fields) {
      values[field.key] = field.value;
    }
    return values;
  }, [fields]);

  const submit = useCallback((): FormResult => {
    const values = getValues();
    return { submitted: true, values };
  }, [getValues]);

  const beginSubmit = useCallback((message = "Saving changes…"): boolean => {
    if (isSubmittingRef.current) return false;
    isSubmittingRef.current = true;
    setSubmitState({ status: "saving", message });
    return true;
  }, []);

  const finishSubmit = useCallback((status: "success" | "error", message: string) => {
    isSubmittingRef.current = false;
    setSubmitState({ status, message });
    if (status === "error") {
      logger.error("Form submission failed", { message });
    }
  }, []);

  const resetSubmitState = useCallback(() => {
    setSubmitState(IDLE_SUBMIT_STATE);
  }, []);

  return {
    active,
    fields,
    focusIdx,
    submitState,
    open,
    close,
    updateValue,
    setFocusIdx,
    nextField,
    prevField,
    getValues,
    submit,
    beginSubmit,
    finishSubmit,
    resetSubmitState,
  };
}

type RenderProps = {
  title: string;
  fields: FormField[];
  focusIdx: number;
  onChange: (key: string, value: string) => void;
  submitState: FormSubmitState;
  onSubmit: () => void | Promise<void>;
  onCancel: () => void;
  onNextField: () => void;
  onPrevField: () => void;
};

type TextareaRef = {
  plainText: string;
} | null;

export function EditFormOverlay({
  title,
  fields,
  focusIdx,
  onChange,
  submitState,
  onSubmit,
  onCancel,
  onNextField,
  onPrevField,
}: RenderProps) {
  const { width, height } = useTerminalDimensions();
  const textareaRefs = useRef<Record<string, TextareaRef>>({});
  const screen = getScreenSize(width);
  const compact = screen === "xs";

  const boxWidth = compact
    ? Math.max(24, width - 2)
    : screen === "sm"
      ? Math.min(78, width - 2)
      : screen === "md"
        ? Math.min(100, width - 4)
        : Math.min(Math.round(width * 0.6), width - 4);
  const defaultTextareaHeight = compact ? 4 : screen === "lg" ? 10 : 6;
  const contentHeight = useMemo(() => {
    return fields.reduce(
      (total, field) =>
        total + (field.type === "textarea" ? (field.height ?? defaultTextareaHeight) : 3),
      2,
    );
  }, [defaultTextareaHeight, fields]);
  const minFormHeight = compact ? height - 2 : Math.round(height * 0.6);
  const boxHeight = Math.max(minFormHeight, Math.min(height - 2, contentHeight + (compact ? 7 : 9)));

  const handleFieldKey = (key: KeyEvent) => {
    if (submitState.status === "saving") return;

    if (isSaveKey(key)) {
      void onSubmit();
      return;
    }

    if (key.name === "escape") {
      onCancel();
      return;
    }

    if (key.name === "tab" && key.shift) {
      onPrevField();
      return;
    }

    if (key.name === "tab") {
      onNextField();
    }
  };

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
      backgroundColor={colors.bg}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
      zIndex={100}
    >
      <box
        width={boxWidth}
        height={boxHeight}
        flexDirection="column"
        border
        borderStyle="rounded"
        borderColor={colors.borderFocus}
        backgroundColor={colors.bgElevated}
        padding={1}
        title={` ${title} `}
        titleAlignment="left"
      >
        <scrollbox
          flexGrow={1}
          height="100%"
          minHeight={0}
          viewportOptions={{ backgroundColor: colors.bgElevated }}
          contentOptions={{ backgroundColor: colors.bgElevated }}
          scrollbarOptions={{
            trackOptions: {
              foregroundColor: colors.accentSoft,
              backgroundColor: colors.border,
            },
          }}
        >
          <box
            flexDirection="column"
            gap={1}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={1}
            paddingRight={1}
          >
            {fields.map((field, index) => {
              const focused = focusIdx === index;
              const fieldType = field.type ?? (field.options ? "select" : "input");

              return (
                <box
                  key={field.key}
                  flexDirection="column"
                  gap={1}
                  paddingTop={1}
                  paddingBottom={1}
                >
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={focused ? colors.accent : colors.text}>{field.label}</text>
                    <text fg={colors.textMuted}>{focused ? "editing" : "field"}</text>
                  </box>

                  {fieldType === "select" ? (
                    <box
                      border
                      borderStyle="single"
                      borderColor={focused ? colors.borderFocus : colors.border}
                      backgroundColor={colors.bg}
                      padding={1}
                    >
                      <select
                        focused={focused}
                        height={Math.min(4, field.options?.length ?? 1)}
                        options={(field.options ?? []).map((option) => ({
                          name: option.label,
                          description: option.description ?? "",
                          value: option.value,
                        }))}
                        selectedIndex={Math.max(
                          0,
                          (field.options ?? []).findIndex((option) => option.value === field.value),
                        )}
                        showDescription={false}
                        showScrollIndicator={(field.options?.length ?? 0) > 4}
                        backgroundColor={colors.bg}
                        textColor={colors.text}
                        focusedBackgroundColor={colors.bg}
                        focusedTextColor={colors.text}
                        selectedBackgroundColor={colors.bgSelected}
                        selectedTextColor={colors.accent}
                        descriptionColor={colors.textMuted}
                        selectedDescriptionColor={colors.textDim}
                        onKeyDown={handleFieldKey}
                        onChange={(_, option) => onChange(field.key, String(option?.value ?? ""))}
                      />
                    </box>
                  ) : fieldType === "textarea" ? (
                    <box
                      border
                      borderStyle="single"
                      borderColor={focused ? colors.borderFocus : colors.border}
                      backgroundColor={colors.bg}
                      padding={1}
                    >
                      <textarea
                        ref={(instance) => {
                          textareaRefs.current[field.key] = instance as TextareaRef;
                        }}
                        focused={focused}
                        height={field.height ?? defaultTextareaHeight}
                        initialValue={field.value}
                        placeholder={field.placeholder ?? ""}
                        wrapMode="word"
                        backgroundColor={colors.bg}
                        textColor={colors.text}
                        focusedBackgroundColor={colors.bg}
                        focusedTextColor={colors.text}
                        placeholderColor={colors.textMuted}
                        onKeyDown={handleFieldKey}
                        onContentChange={() => {
                          const current = textareaRefs.current[field.key]?.plainText ?? "";
                          onChange(field.key, current);
                        }}
                      />
                    </box>
                  ) : (
                    <box
                      border
                      borderStyle="single"
                      borderColor={focused ? colors.borderFocus : colors.border}
                      backgroundColor={colors.bg}
                      padding={1}
                    >
                      <input
                        focused={focused}
                        value={field.value}
                        placeholder={field.placeholder ?? ""}
                        backgroundColor={colors.bg}
                        textColor={colors.text}
                        cursorColor={colors.accent}
                        focusedBackgroundColor={colors.bg}
                        placeholderColor={colors.textMuted}
                        onInput={(value) => onChange(field.key, value)}
                        onKeyDown={handleFieldKey}
                      />
                    </box>
                  )}

                  {field.description ? (
                    <text fg={colors.textMuted}>{field.description}</text>
                  ) : null}
                </box>
              );
            })}
          </box>
        </scrollbox>

        <box
          flexDirection={compact ? "column" : "row"}
          justifyContent="space-between"
          alignItems={compact ? "flex-start" : "center"}
          gap={compact ? 1 : 2}
          marginTop={1}
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
          border
          borderStyle="single"
          flexShrink={0}
          borderColor={
            submitState.status === "error"
              ? colors.error
              : submitState.status === "success"
                ? colors.success
                : submitState.status === "saving"
                  ? colors.warning
                  : colors.border
          }
          backgroundColor={colors.bg}
        >
          <text
            fg={
              submitState.status === "error"
                ? colors.error
                : submitState.status === "success"
                  ? colors.success
                  : submitState.status === "saving"
                    ? colors.warning
                    : colors.success
            }
          >
            {submitState.message ??
              (submitState.status === "saving" ? "Saving changes…" : "Save: Ctrl+S or F2")}
          </text>
          <text fg={colors.textMuted}>
            {submitState.status === "saving" ? "Please wait…" : "Cancel: Esc"}
          </text>
        </box>
      </box>
    </box>
  );
}
