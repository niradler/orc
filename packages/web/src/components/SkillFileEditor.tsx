import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/api/client";
import { CodeEditor } from "@/components/CodeEditor";
import { Button } from "@/components/ui/button";

export function SkillFileEditor({
  name,
  path,
  content,
  onClose,
}: {
  name: string;
  path: string;
  content: string;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(content);
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: () => api.skills.editFile(name, { path, content: draft, expectedContent: content }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["skill", name] });
      await queryClient.invalidateQueries({ queryKey: ["skills"] });
      onClose();
    },
  });
  return (
    <div className="space-y-3">
      <CodeEditor
        testId="skill-edit-content"
        path={path}
        value={draft}
        onChange={setDraft}
        height={350}
      />
      {save.error && (
        <p role="alert" className="text-sm text-destructive">
          {save.error.message}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          data-testid="skill-save-edit"
          disabled={save.isPending || draft === content}
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Saving…" : "Save changes"}
        </Button>
        <Button variant="ghost" disabled={save.isPending} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
