import { nativeChatAgent } from "@orc/core/chat";
import { useCallback } from "react";
import { api } from "@/api/client";
import { useChat } from "@/hooks/useChat";
import { useSessionHome } from "@/hooks/useSessionHome";

export function useOpenLiveSession() {
  const { openThread, tabs, selectTab } = useChat();
  const { go } = useSessionHome();
  return useCallback(
    async (id: string) => {
      const session = await api.sessions.liveOne(id);
      const open = tabs.find(
        (tab) =>
          tab.thread?.sourceId === id ||
          (!!session.session_id && tab.thread?.runtimeId === session.session_id),
      );
      if (open?.thread) {
        selectTab(open.key);
        go({ viewId: null, terminalId: null, liveId: null }, { chatThread: open.thread.id });
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
