import { SyntaxStyle } from "@opentui/core";
import { colors } from "../theme.js";

const syntaxStyle = SyntaxStyle.create();

export type Field = {
  label: string;
  value: string;
  color?: string | undefined;
};

type Props = {
  title: string;
  fields: Field[];
  body?: string | undefined;
  renderMarkdown?: boolean | undefined;
};

export function DetailPane({ title, fields, body, renderMarkdown }: Props) {
  return (
    <box
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={colors.border}
      backgroundColor={colors.bgElevated}
      padding={1}
      flexGrow={1}
    >
      <box
        flexDirection="row"
        justifyContent="space-between"
        alignItems="center"
        flexShrink={0}
        backgroundColor={colors.bgLight}
        paddingLeft={1}
        paddingRight={1}
        paddingTop={1}
        paddingBottom={1}
      >
        <text fg={colors.accent}>
          <strong>{title}</strong>
        </text>
        <text fg={colors.textMuted}>{"Esc back • Up/Down scroll"}</text>
      </box>

      <box
        flexDirection="column"
        border
        borderStyle="single"
        borderColor={colors.border}
        marginTop={1}
        flexShrink={0}
        padding={1}
        backgroundColor={colors.bg}
      >
        <text fg={colors.textDim} paddingBottom={1}>
          {"Details"}
        </text>
        {fields.map((f) => (
          <box key={f.label} flexDirection="row" gap={1}>
            <text fg={colors.textDim} width={16}>
              {f.label}
            </text>
            <text fg={f.color ?? colors.text}>{f.value}</text>
          </box>
        ))}
      </box>

      {body ? (
        <box
          flexDirection="column"
          border
          borderStyle="single"
          borderColor={colors.border}
          marginTop={1}
          minHeight={0}
          padding={1}
          backgroundColor={colors.bg}
          flexGrow={1}
        >
          <text fg={colors.textDim} paddingBottom={1}>
            {"Content"}
          </text>
          <scrollbox
            flexGrow={1}
            height="100%"
            minHeight={3}
            focused
            viewportOptions={{ backgroundColor: colors.bg }}
            contentOptions={{ backgroundColor: colors.bg }}
            scrollbarOptions={{
              trackOptions: {
                foregroundColor: colors.accentSoft,
                backgroundColor: colors.border,
              },
            }}
          >
            {renderMarkdown ? (
              <markdown content={body} syntaxStyle={syntaxStyle} conceal />
            ) : (
              <text fg={colors.text}>{body}</text>
            )}
          </scrollbox>
        </box>
      ) : null}
    </box>
  );
}
