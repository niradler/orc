import { Component, lazy, type ReactNode, Suspense } from "react";
import { InvalidChatUi } from "./InvalidChatUi";

// json-render and the component registry load only when a reply contains a block.
const ChatUiRenderer = lazy(() => import("./ChatUiRenderer"));

const Pending = () => (
  <div
    role="status"
    aria-label="Loading component"
    data-testid="chat-ui-pending"
    className="my-2 h-16 animate-pulse rounded-lg border border-outline-variant bg-surface"
  />
);

/** Keeps a broken component from taking down the chat transcript. */
class ChatUiBoundary extends Component<
  { source: string; children: ReactNode },
  { error: string | null }
> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  componentDidUpdate(previous: { source: string }) {
    if (previous.source !== this.props.source && this.state.error) this.setState({ error: null });
  }

  render() {
    if (this.state.error)
      return <InvalidChatUi source={this.props.source} error={this.state.error} />;
    return this.props.children;
  }
}

export function ChatUiBlock({ source, complete }: { source: string; complete: boolean }) {
  if (!complete) return <Pending />;
  return (
    <ChatUiBoundary source={source}>
      <Suspense fallback={<Pending />}>
        <ChatUiRenderer source={source} />
      </Suspense>
    </ChatUiBoundary>
  );
}
