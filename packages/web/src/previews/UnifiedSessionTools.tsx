import { Check, FileCode, GitBranch, GitPullRequest, Plus, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { DiffLines } from "@/components/terminals/FileDiffCard";
import { Button } from "@/components/ui/button";
import { diffLines } from "@/lib/git-diff";
import { cn } from "@/lib/utils";

export interface MockConfiguration {
  permission: string;
  effort: string;
  tools: string;
  instructions: string;
  worktree: string;
  launchOptions: string;
}
export const initialConfiguration: MockConfiguration = {
  permission: "default",
  effort: "Agent default",
  tools: "ORC + host tools",
  instructions: "",
  worktree: "Current checkout",
  launchOptions: "",
};
export type ToolTab = "Changes" | "Diff" | "Files" | "Worktrees" | "PR";
const files = [
  "src/components/SessionWorkspace.tsx",
  "src/components/SessionComposer.tsx",
  "src/styles/workspace.css",
];
const demoDiff = diffLines(
  "diff --git a/SessionComposer.tsx b/SessionComposer.tsx\n--- a/SessionComposer.tsx\n+++ b/SessionComposer.tsx\n@@ -1,3 +1,4 @@\n export function SessionComposer() {\n-  return <SeparateWorkspaceControls />;\n+  return <ComposerToolbar />;\n+  // Detailed configuration opens above the input.\n }",
);

export function UnifiedSessionTools({
  project,
  branch,
  worktree,
  tab,
  onTab,
  onClose,
  onCheckout,
}: {
  project: string;
  branch: string;
  worktree: string;
  tab: ToolTab;
  onTab: (tab: ToolTab) => void;
  onClose: () => void;
  onCheckout: (branch: string, worktree: string) => void;
}): ReactNode {
  const [selectedFile, setSelectedFile] = useState(files[0]);
  const [creating, setCreating] = useState(false);
  const [newBranch, setNewBranch] = useState("design/composer-review");
  const [created, setCreated] = useState<string[]>([]);
  const [staged, setStaged] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  return (
    <aside className="uw-tools" aria-label="Session Git and workspace tools">
      <header>
        <div>
          <strong>Workspace</strong>
          <p>
            {project} / {branch}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close workspace tools"
          actionHelp={false}
          onClick={onClose}
        >
          <X size={16} />
        </Button>
      </header>
      <nav className="uw-tool-tabs" aria-label="Workspace tool">
        {(["Changes", "Diff", "Files", "Worktrees", "PR"] as const).map((item) => (
          <button type="button" key={item} aria-pressed={tab === item} onClick={() => onTab(item)}>
            {item}
          </button>
        ))}
      </nav>
      <div className="uw-tools-body">
        {tab === "Changes" && (
          <>
            <div className="uw-tool-summary">
              <GitBranch size={15} />
              <span>{branch}</span>
              <span className="ml-auto text-success">
                +84 <span className="text-error">−21</span>
              </span>
            </div>
            <p className="uw-tool-caption">Local changes · 3 files</p>
            {files.map((file) => (
              <div className="uw-changed-file" key={file}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedFile(file);
                    onTab("Diff");
                  }}
                >
                  <FileCode size={14} />
                  <span>{file.split("/").slice(-1)[0]}</span>
                </button>
                <button
                  type="button"
                  aria-label={`${staged.includes(file) ? "Unstage" : "Stage"} ${file}`}
                  onClick={() =>
                    setStaged(
                      staged.includes(file)
                        ? staged.filter((item) => item !== file)
                        : [...staged, file],
                    )
                  }
                >
                  {staged.includes(file) ? <Check size={14} /> : <Plus size={14} />}
                </button>
              </div>
            ))}
            <div className="uw-git-actions">
              <Button variant="outline" size="sm" onClick={() => onTab("Diff")}>
                Review diff
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setNotice(
                    "Commit and push will reuse the existing Git flow. No Git command runs in this mock.",
                  )
                }
              >
                Commit / push
              </Button>
            </div>
            <p className="uw-tool-caption">
              {staged.length} staged in this mock. Your repository is untouched.
            </p>
          </>
        )}
        {tab === "Diff" && (
          <>
            <label className="uw-tool-field">
              Changed file
              <select
                aria-label="Diff file"
                value={selectedFile}
                onChange={(event) => setSelectedFile(event.target.value)}
              >
                {files.map((file) => (
                  <option key={file}>{file}</option>
                ))}
              </select>
            </label>
            <label className="uw-tool-field">
              Compare
              <select aria-label="Diff comparison">
                <option>Working tree</option>
                <option>Branch vs main</option>
                <option>Last turn (planned)</option>
              </select>
            </label>
            <div className="uw-demo-diff">
              <DiffLines lines={demoDiff} />
            </div>
            <p className="uw-tool-caption">
              Illustrative diff rendered by ORC's existing diff component.
            </p>
          </>
        )}
        {tab === "Files" && (
          <>
            <p className="uw-tool-caption">Workspace files</p>
            {files.map((file) => (
              <button
                type="button"
                className={cn("uw-file-row", selectedFile === file && "bg-surface-highest")}
                key={file}
                onClick={() => setSelectedFile(file)}
              >
                <FileCode size={14} />
                {file.split("/").slice(-1)[0]}
              </button>
            ))}
            <pre className="uw-file-preview">{`// ${selectedFile}\n\nexport function Workspace() {\n  return <SessionView />;\n}`}</pre>
            <Button variant="ghost" size="sm" onClick={() => onTab("Diff")}>
              View file changes
            </Button>
          </>
        )}
        {tab === "Worktrees" && (
          <>
            <p className="uw-tool-caption">Branches and worktrees share this session context.</p>
            {[...new Set(["Current checkout", "fix/ssh-auth", worktree, ...created])].map(
              (item) => (
                <button
                  type="button"
                  className={cn("uw-worktree-row", worktree === item && "bg-surface-highest")}
                  key={item}
                  onClick={() => onCheckout(item === "Current checkout" ? "main" : item, item)}
                >
                  <GitBranch size={15} />
                  <span>
                    {item}
                    <small>
                      ~/projects/{project.toLowerCase()}
                      {item === "Current checkout"
                        ? ""
                        : `/.orc/worktrees/${item.split("/").slice(-1)[0]}`}
                    </small>
                  </span>
                  {worktree === item && <Check size={14} />}
                </button>
              ),
            )}
            <Button variant="outline" size="sm" onClick={() => setCreating(!creating)}>
              <Plus size={14} />
              New worktree
            </Button>
            {creating && (
              <form
                className="uw-worktree-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const value = newBranch.trim();
                  if (!value || created.includes(value)) return;
                  setCreated([...created, value]);
                  onCheckout(value, value);
                  setCreating(false);
                }}
              >
                <label className="uw-tool-field">
                  New branch
                  <input
                    aria-label="New worktree branch"
                    value={newBranch}
                    onChange={(event) => setNewBranch(event.target.value)}
                    maxLength={80}
                    required
                  />
                </label>
                <Button type="submit" size="sm">
                  Create mock worktree
                </Button>
              </form>
            )}
          </>
        )}
        {tab === "PR" && (
          <>
            <div className="flex items-center gap-2 mb-4">
              <GitPullRequest size={18} />
              <h2>Pull request</h2>
            </div>
            <p className="text-sm">Workspace review</p>
            <p className="uw-tool-caption">Draft · {branch} → main</p>
            <div className="uw-git-actions">
              <Button variant="outline" size="sm" onClick={() => onTab("Diff")}>
                Review changes
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setNotice(
                    "PR comments, checks, review and merge remain in the existing Git/PR flow. This mock publishes nothing.",
                  )
                }
              >
                PR actions
              </Button>
            </div>
          </>
        )}
        <p className="uw-tool-footnote" role="status">
          {notice || "Demo workspace · no Git, file or worktree changes are made"}
        </p>
      </div>
    </aside>
  );
}
