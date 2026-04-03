import { useTerminalDimensions } from "@opentui/react";
import { useCallback, useMemo, useRef, useState } from "react";
import { colors } from "../theme.js";
import type { SelectOption } from "../types.js";

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

export function useEditForm() {
  const [active, setActive] = useState(false);
  const [fields, setFields] = useState<FormField[]>([]);
  const [focusIdx, setFocusIdx] = useState(0);

  const open = useCallback((newFields: FormField[]) => {
    setFields(newFields);
    setFocusIdx(0);
    setActive(true);
  }, []);

  const close = useCallback(() => {
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
    setActive(false);
    return { submitted: true, values };
  }, [getValues]);

  return {
    active,
    fields,
    focusIdx,
    open,
    close,
    updateValue,
    setFocusIdx,
    nextField,
    prevField,
    getValues,
    submit,
  };
}

type RenderProps = {
  title: string;
  fields: FormField[];
  focusIdx: number;
  active: boolean;
  onChange: (key: string, value: string) => void;
};

type TextareaRef = {
  plainText: string;
} | null;

export function EditFormOverlay({ title, fields, focusIdx, active, onChange }: RenderProps) {
  const { width, height } = useTerminalDimensions();
  const textareaRefs = useRef<Record<string, TextareaRef>>({});
  const compact = width < 88;

  const boxWidth = compact ? Math.max(28, width - 2) : Math.min(92, width - 4);
  const contentHeight = useMemo(() => {
    return fields.reduce(
      (total, field) => total + (field.type === "textarea" ? (field.height ?? 6) : 3),
      2,
    );
  }, [fields]);
  const boxHeight = Math.max(10, Math.min(height - 2, contentHeight + (compact ? 6 : 8)));

  if (!active) return null;

  return (
    <box
      position="absolute"
      top={Math.max(1, Math.min(height - boxHeight - 1, Math.floor((height - boxHeight) / 2)))}
      left={Math.max(1, Math.floor((width - boxWidth) / 2))}
      width={boxWidth}
      height={boxHeight}
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={colors.borderFocus}
      backgroundColor={colors.bgElevated}
      padding={1}
      zIndex={100}
    >
      <box
        flexDirection="row"
        justifyContent={compact ? "flex-start" : "space-between"}
        alignItems={compact ? "flex-start" : "center"}
        flexWrap={compact ? "wrap" : "no-wrap"}
        backgroundColor={colors.bgLight}
        paddingLeft={1}
        paddingRight={1}
        paddingTop={0}
        paddingBottom={0}
        flexShrink={0}
      >
        <text fg={colors.accent}>
          <strong>{title}</strong>
        </text>
        <text fg={colors.textMuted}>{"Tab cycle • Ctrl+S save • Esc cancel"}</text>
      </box>

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
        <box flexDirection="column" gap={1} paddingTop={1} paddingBottom={1}>
          {fields.map((field, index) => {
            const focused = focusIdx === index;
            const fieldType = field.type ?? (field.options ? "select" : "input");

            return (
              <box
                key={field.key}
                flexDirection="column"
                border
                borderStyle="single"
                borderColor={focused ? colors.borderFocus : colors.border}
                backgroundColor={focused ? colors.bg : colors.bgElevated}
                padding={1}
              >
                <box flexDirection="row" justifyContent="space-between" marginBottom={1}>
                  <text fg={focused ? colors.accent : colors.text}>{field.label}</text>
                  <text fg={colors.textMuted}>{focused ? "active" : "field"}</text>
                </box>

                {fieldType === "select" ? (
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
                    onChange={(_, option) => onChange(field.key, String(option?.value ?? ""))}
                  />
                ) : fieldType === "textarea" ? (
                  <textarea
                    ref={(instance) => {
                      textareaRefs.current[field.key] = instance as TextareaRef;
                    }}
                    focused={focused}
                    height={field.height ?? 6}
                    initialValue={field.value}
                    placeholder={field.placeholder ?? ""}
                    wrapMode="word"
                    backgroundColor={colors.bg}
                    textColor={colors.text}
                    focusedBackgroundColor={colors.bg}
                    focusedTextColor={colors.text}
                    placeholderColor={colors.textMuted}
                    onContentChange={() => {
                      const current = textareaRefs.current[field.key]?.plainText ?? "";
                      onChange(field.key, current);
                    }}
                  />
                ) : (
                  <input
                    focused={focused}
                    value={field.value}
                    placeholder={field.placeholder ?? ""}
                    backgroundColor={colors.bg}
                    textColor={colors.text}
                    cursorColor={colors.accent}
                    focusedBackgroundColor={colors.bg}
                    placeholderColor={colors.textMuted}
                    onChange={(value) => onChange(field.key, value)}
                  />
                )}

                {field.description ? (
                  <text fg={colors.textMuted} marginTop={1}>
                    {field.description}
                  </text>
                ) : null}
              </box>
            );
          })}
        </box>
      </scrollbox>
    </box>
  );
}
