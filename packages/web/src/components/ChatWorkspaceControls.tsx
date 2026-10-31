import { useEffect, useState } from "react";
import { RecentFolders } from "@/components/RecentFolders";
import { RemoteFolderBrowser } from "@/components/terminals/RemoteFolderBrowser";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useChat } from "@/hooks/useChat";
import { useSsh } from "@/hooks/useSsh";
import { folderHistory, rememberFolder } from "@/lib/folder-history";

export function ChatWorkspaceControls() {
  const { workspace, setWorkspace, thread, streaming } = useChat();
  const { data: ssh } = useSsh();
  const [browse, setBrowse] = useState(false);
  const host = workspace?.host === undefined ? (ssh?.host ?? null) : workspace.host;
  const cwd = workspace?.cwd ?? folderHistory(host).last;
  useEffect(() => {
    if (ssh && !workspace && !thread && !streaming)
      setWorkspace({ host: ssh.host, cwd: folderHistory(ssh.host).last, worktree: false });
  }, [ssh, workspace, thread, streaming, setWorkspace]);
  if (thread) return null;
  const choose = (path: string) => {
    setWorkspace({ host, cwd: path, worktree: workspace?.worktree ?? false });
  };
  return (
    <details data-testid="chat-workspace" className="px-4 py-2 text-sm">
      <summary className="cursor-pointer min-h-11 py-3 wrap-break-word">
        Working folder: {cwd || "Default folder"}
        {workspace?.worktree ? " · New worktree" : ""}
      </summary>
      <div className="space-y-3 pb-2">
        <label className="block space-y-1">
          <span>Host</span>
          <select
            data-testid="chat-workspace-host"
            value={host ?? ""}
            disabled={streaming || !ssh}
            className="w-full min-h-11 rounded-md border border-control-border bg-background px-2"
            onChange={(event) => {
              const next = event.target.value || null;
              setWorkspace({
                host: next,
                cwd: folderHistory(next).last,
                worktree: workspace?.worktree ?? false,
              });
              setBrowse(false);
            }}
          >
            <option value="">Local</option>
            {[...new Set([...(ssh?.hosts ?? []), ...(ssh?.host ? [ssh.host] : [])])].map(
              (alias) => (
                <option key={alias}>{alias}</option>
              ),
            )}
          </select>
        </label>
        <label htmlFor="chat-workspace-folder" className="block space-y-1">
          <span>Folder</span>
          <Input
            id="chat-workspace-folder"
            data-testid="chat-workspace-cwd"
            value={cwd}
            disabled={streaming || !ssh}
            onChange={(event) => choose(event.target.value)}
            onBlur={() => rememberFolder(host, cwd)}
          />
        </label>
        <Button
          data-testid="chat-workspace-browse"
          variant="outline"
          disabled={streaming || !ssh}
          onClick={() => setBrowse(!browse)}
        >
          Browse
        </Button>
        <RecentFolders
          host={host}
          disabled={streaming || !ssh}
          onPick={(path) => {
            choose(path);
            rememberFolder(host, path);
          }}
        />
        {browse && (
          <RemoteFolderBrowser
            key={host}
            host={host}
            initial={cwd}
            onClose={() => setBrowse(false)}
            onPick={(path) => {
              choose(path);
              rememberFolder(host, path);
              setBrowse(false);
            }}
          />
        )}
        <label className="flex items-center gap-2 min-h-11">
          <input
            type="checkbox"
            data-testid="chat-workspace-worktree"
            checked={workspace?.worktree ?? false}
            disabled={streaming || !cwd.trim()}
            onChange={(event) => setWorkspace({ host, cwd, worktree: event.target.checked })}
          />
          New git worktree
        </label>
      </div>
    </details>
  );
}
