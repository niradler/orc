import type { ReactNode } from "react";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { SourceCodeEditor } from "@/components/SourceCodeEditor";
import { isMarkdownFile } from "@/lib/editor-language";

export type CodeEditorProps = {
  path: string;
  value: string;
  onChange?: (value: string) => void;
  onSave?: () => void;
  readOnly?: boolean;
  height?: number | string;
  testId?: string;
  id?: string;
  label?: string;
  placeholder?: string;
  hidePreview?: boolean;
  defaultWrap?: boolean;
  header?: ReactNode;
};

export function CodeEditor(props: CodeEditorProps) {
  if (isMarkdownFile(props.path) && !props.hidePreview) return <MarkdownEditor {...props} />;
  return <SourceCodeEditor {...props} />;
}
