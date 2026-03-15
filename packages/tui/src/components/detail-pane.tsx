import { colors } from "../theme.js";

export type Field = {
  label: string;
  value: string;
  color?: string | undefined;
};

type Props = {
  title: string;
  fields: Field[];
  body?: string | undefined;
};

export function DetailPane({ title, fields, body }: Props) {
  return (
    <box
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={colors.border}
      backgroundColor={colors.bg}
      padding={1}
      flexGrow={1}
    >
      <text fg={colors.accent} paddingBottom={1}>
        {title}
      </text>
      {fields.map((f) => (
        <box key={f.label} flexDirection="row" gap={1}>
          <text fg={colors.textDim} width={16}>
            {f.label}
          </text>
          <text fg={f.color ?? colors.text}>{f.value}</text>
        </box>
      ))}
      {body && (
        <box marginTop={1} paddingTop={1}>
          <text fg={colors.text}>{body}</text>
        </box>
      )}
      <box marginTop={1}>
        <text fg={colors.textMuted}>{"Esc back"}</text>
      </box>
    </box>
  );
}
