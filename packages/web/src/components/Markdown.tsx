import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import { memo } from "react";
import { Streamdown } from "streamdown";

const plugins = { code, mermaid };

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <Streamdown
      mode="static"
      plugins={plugins}
      shikiTheme={["github-dark", "github-dark"]}
      mermaid={{ config: { theme: "dark" } }}
      controls={{
        table: false,
        code: { copy: true, download: false },
        mermaid: { copy: true, download: false, fullscreen: true, panZoom: true },
      }}
      className="text-xs leading-relaxed text-on-surface [&_p]:my-2 [&_pre]:text-[11px] [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-xs [&_a]:text-primary [&_ul]:my-2 [&_ol]:my-2"
    >
      {children}
    </Streamdown>
  );
});
