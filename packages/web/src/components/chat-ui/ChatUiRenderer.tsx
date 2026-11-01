import { JSONUIProvider, Renderer, type Spec } from "@json-render/react";
import { parseChatUiSpec } from "@orc/core/chat-ui";
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { ChatUiActionProvider, useChatUiHandlers } from "./actions";
import { InvalidChatUi } from "./InvalidChatUi";
import { registry } from "./registry";

function SpecView({ spec }: { spec: Spec }) {
  const handlers = useChatUiHandlers();
  const navigate = useNavigate();
  return (
    <JSONUIProvider registry={registry} handlers={handlers} navigate={navigate}>
      <Renderer spec={spec} registry={registry} />
    </JSONUIProvider>
  );
}

/** Lazy chunk: validates the spec and renders it with live ORC components. */
export default function ChatUiRenderer({ source }: { source: string }) {
  const parsed = useMemo(() => parseChatUiSpec(source), [source]);
  if (!parsed.ok) return <InvalidChatUi source={source} error={parsed.error} />;
  return (
    <div data-testid="chat-ui-block" className="my-2 min-w-0">
      <ChatUiActionProvider>
        <SpecView spec={parsed.spec} />
      </ChatUiActionProvider>
    </div>
  );
}
