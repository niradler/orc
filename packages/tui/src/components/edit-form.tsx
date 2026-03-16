import { useTerminalDimensions } from "@opentui/react";
import { useCallback, useRef, useState } from "react";
import { colors } from "../theme.js";
import type { KeyEvent } from "../types.js";

export type FormField = {
  key: string;
  label: string;
  value: string;
  options?: string[];
};

export function useEditForm() {
  const [active, setActive] = useState(false);
  const [fields, setFields] = useState<FormField[]>([]);
  const [focusIdx, setFocusIdx] = useState(0);
  const [editing, setEditing] = useState(false);
  const activeRef = useRef(false);
  const fieldsRef = useRef<FormField[]>([]);
  const focusIdxRef = useRef(0);
  const editingRef = useRef(false);

  const open = useCallback((newFields: FormField[]) => {
    setFields(newFields);
    fieldsRef.current = newFields;
    setFocusIdx(0);
    focusIdxRef.current = 0;
    setEditing(false);
    editingRef.current = false;
    setActive(true);
    activeRef.current = true;
  }, []);

  const close = useCallback(() => {
    setActive(false);
    activeRef.current = false;
    setEditing(false);
    editingRef.current = false;
  }, []);

  const getValues = useCallback((): Record<string, string> => {
    const vals: Record<string, string> = {};
    for (const f of fieldsRef.current) vals[f.key] = f.value;
    return vals;
  }, []);

  const handleKey = useCallback(
    (key: KeyEvent, onSubmit: (vals: Record<string, string>) => void): boolean => {
      if (!activeRef.current) return false;

      if (key.name === "escape") {
        if (editingRef.current) {
          setEditing(false);
          editingRef.current = false;
        } else {
          close();
        }
        return true;
      }

      if (key.name === "s" && key.ctrl) {
        onSubmit(getValues());
        close();
        return true;
      }

      if (!editingRef.current) {
        if (key.name === "j" || key.name === "down" || key.name === "tab") {
          const next = (focusIdxRef.current + 1) % fieldsRef.current.length;
          setFocusIdx(next);
          focusIdxRef.current = next;
          return true;
        }
        if (key.name === "k" || key.name === "up") {
          const prev =
            (focusIdxRef.current - 1 + fieldsRef.current.length) % fieldsRef.current.length;
          setFocusIdx(prev);
          focusIdxRef.current = prev;
          return true;
        }
        if (key.name === "return" || key.name === "e") {
          const field = fieldsRef.current[focusIdxRef.current];
          if (field?.options) {
            const opts = field.options;
            const curIdx = opts.indexOf(field.value);
            const nextIdx = (curIdx + 1) % opts.length;
            const updated = [...fieldsRef.current];
            updated[focusIdxRef.current] = {
              ...field,
              value: opts[nextIdx] ?? field.value,
            };
            setFields(updated);
            fieldsRef.current = updated;
          } else {
            setEditing(true);
            editingRef.current = true;
          }
          return true;
        }
        return true;
      }

      if (key.name === "return") {
        setEditing(false);
        editingRef.current = false;
        return true;
      }

      if (key.name === "backspace") {
        const updated = [...fieldsRef.current];
        const field = updated[focusIdxRef.current];
        if (field) {
          updated[focusIdxRef.current] = {
            ...field,
            value: field.value.slice(0, -1),
          };
          setFields(updated);
          fieldsRef.current = updated;
        }
        return true;
      }

      if (key.name === "space") {
        const updated = [...fieldsRef.current];
        const field = updated[focusIdxRef.current];
        if (field) {
          updated[focusIdxRef.current] = { ...field, value: `${field.value} ` };
          setFields(updated);
          fieldsRef.current = updated;
        }
        return true;
      }

      if (key.name.length === 1 && !key.ctrl && !key.meta) {
        const updated = [...fieldsRef.current];
        const field = updated[focusIdxRef.current];
        if (field) {
          updated[focusIdxRef.current] = {
            ...field,
            value: field.value + key.name,
          };
          setFields(updated);
          fieldsRef.current = updated;
        }
        return true;
      }

      return true;
    },
    [close, getValues],
  );

  return { active, fields, focusIdx, editing, open, close, handleKey, getValues };
}

type RenderProps = {
  title: string;
  fields: FormField[];
  focusIdx: number;
  editing: boolean;
  active: boolean;
};

export function EditFormOverlay({ title, fields, focusIdx, editing, active }: RenderProps) {
  const { width, height } = useTerminalDimensions();

  if (!active) return null;

  const boxWidth = Math.min(70, width - 4);
  const boxHeight = fields.length + 6;

  return (
    <box
      position="absolute"
      top={Math.max(1, Math.floor(height / 2) - Math.floor(boxHeight / 2))}
      left={Math.floor((width - boxWidth) / 2)}
      width={boxWidth}
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={colors.accent}
      backgroundColor={colors.bg}
      padding={1}
      zIndex={100}
    >
      <text fg={colors.accent} paddingBottom={1}>
        {title}
      </text>
      {fields.map((f, i) => {
        const focused = i === focusIdx;
        const isEditing = focused && editing;
        return (
          <box key={f.key} flexDirection="row" gap={1}>
            <text fg={focused ? colors.accent : colors.textMuted} width={1}>
              {focused ? ">" : " "}
            </text>
            <text fg={colors.textDim} width={14}>
              {f.label}
            </text>
            {f.options ? (
              <text fg={focused ? colors.accent : colors.text}>{`< ${f.value} >`}</text>
            ) : (
              <text fg={isEditing ? colors.accent : colors.text}>
                {isEditing ? `${f.value}█` : f.value || "—"}
              </text>
            )}
          </box>
        );
      })}
      <box marginTop={1}>
        <text fg={colors.textMuted}>
          {editing
            ? "Type to edit  Enter confirm  Esc stop editing"
            : "j/k move  Enter edit  ←→ cycle  Ctrl+S save  Esc cancel"}
        </text>
      </box>
    </box>
  );
}
