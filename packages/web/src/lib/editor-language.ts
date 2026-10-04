import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { yaml, yamlFrontmatter } from "@codemirror/lang-yaml";
import type { Extension } from "@codemirror/state";

export function editorLanguage(path: string): Extension {
  const extension = path.split(".").pop()?.toLowerCase();
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(extension ?? ""))
    return javascript({
      typescript: extension === "ts" || extension === "tsx",
      jsx: extension === "jsx" || extension === "tsx",
    });
  if (extension === "json") return json();
  if (extension === "css") return css();
  if (["html", "htm"].includes(extension ?? "")) return html();
  if (["md", "markdown", "mdx"].includes(extension ?? ""))
    return yamlFrontmatter({ content: markdown() });
  if (["yaml", "yml"].includes(extension ?? "")) return yaml();
  if (extension === "py") return python();
  return [];
}

export function isMarkdownFile(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}
