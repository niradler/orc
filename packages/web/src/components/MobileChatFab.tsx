import { MessageSquare } from "lucide-react";

interface MobileChatFabProps {
  onClick: () => void;
}

/**
 * Mobile-only floating action button that opens the chat sheet.
 * Hidden at md+ via `md:hidden`.
 */
export function MobileChatFab({ onClick }: MobileChatFabProps) {
  return (
    <button
      type="button"
      data-testid="mobile-chat-fab"
      onClick={onClick}
      aria-label="Open chat"
      className="md:hidden fixed bottom-4 right-4 z-40 w-12 h-12 rounded-full bg-primary text-background shadow-lg flex items-center justify-center hover:bg-primary-container transition-colors"
    >
      <MessageSquare size={20} />
    </button>
  );
}
