import { SyntaxStyle } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
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
  hint?: string | undefined;
};

export function DetailPane({ title, fields, body, renderMarkdown, hint }: Props) {
  const { width, height } = useTerminalDimensions();
  const compact = width < 88;
  const labelWidth = compact ? 12 : 16;
  const detailsHeight = body
    ? Math.max(6, Math.min(fields.length + 4, Math.floor(height * 0.45)))
    : undefined;

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
        flexDirection={compact ? "column" : "row"}
        justifyContent="space-between"
        alignItems={compact ? "flex-start" : "center"}
        gap={compact ? 1 : 0}
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
        <text fg={colors.textMuted}>{hint ?? "Esc back • Up/Down scroll"}</text>
      </box>

      <box
        flexDirection="column"
        border
        borderStyle="single"
        borderColor={colors.border}
        marginTop={1}
        minHeight={0}
        padding={1}
        backgroundColor={colors.bg}
        {...(detailsHeight ? { height: detailsHeight } : {})}
      >
        <text fg={colors.textDim} paddingBottom={1}>
          {"Details"}
        </text>
        <scrollbox
          flexGrow={1}
          height="100%"
          minHeight={0}
          viewportOptions={{ backgroundColor: colors.bg }}
          contentOptions={{ backgroundColor: colors.bg }}
          scrollbarOptions={{
            trackOptions: {
              foregroundColor: colors.accentSoft,
              backgroundColor: colors.border,
            },
          }}
        >
          <box flexDirection="column">
            {fields.map((f) => (
              <box key={f.label} flexDirection={compact ? "column" : "row"} gap={1}>
                <text fg={colors.textDim} width={labelWidth}>
                  {f.label}
                </text>
                <text fg={f.color ?? colors.text}>{f.value}</text>
              </box>
            ))}
          </box>
        </scrollbox>
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
