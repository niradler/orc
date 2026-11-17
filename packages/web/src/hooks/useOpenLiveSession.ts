import { nativeChatAgent } from "@orc/core/chat";
import { useCallback } from "react";
import { api } from "@/api/client";
import { useChat } from "@/hooks/useChat";
import { useSessionHome } from "@/hooks/useSessionHome";

/**
 * Opens a live session, reusing the conversation already open for it. A subagent is
 * usually viewed while its parent is still running, and resuming there returns 409;
 * activating the parent's existing tab is both safe and the way back.
 */
export function useOpenLiveSession() {
  const { openThread, tabs, selectTab } = useChat();
  const { go } = useSessionHome();
  return useCallback(
    async (id: string) => {
      // A tab opened from this session is already the way back; activating it needs
      // no round trip and still works while the parent is running or unreachable.
      const bySource = tabs.find((tab) => tab.thread?.sourceId === id);
      if (bySource?.thread) {
        selectTab(bySource.key);
        go({ viewId: null, terminalId: null, liveId: null }, { chatThread: bySource.thread.id });
        return;
      }
      const session = await api.sessions.liveOne(id);
      const byRuntime = tabs.find(
        (tab) => tab.thread && !!session.session_id && tab.thread.runtimeId === session.session_id,
      );
      if (byRuntime?.thread) {
        selectTab(byRuntime.key);
        go({ viewId: null, terminalId: null, liveId: null }, { chatThread: byRuntime.thread.id });
        return;
      }
      if (!nativeChatAgent(session.agent)) {
        go({ viewId: id, terminalId: null, liveId: null });
        return;
      }
      const thread = await api.chat.resume(id);
      openThread(thread);
      go({ viewId: null, terminalId: null, liveId: null }, { chatThread: thread.id });
    },
    [go, openThread, selectTab, tabs],
  );
}
