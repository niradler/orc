import type { Scratchpad } from "@orc/core/scratchpad";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import { useInvalidateScratchpads } from "@/hooks/useScratchpads";

/**
 * An editable copy of a pad's file. Saves are conditional on the revision the draft started from,
 * so an agent's concurrent write surfaces as a conflict instead of being overwritten. While the
 * draft is clean it follows the pad, so live agent edits show up immediately.
 */
export function usePadDraft(pad: Scratchpad) {
  const invalidate = useInvalidateScratchpads();
  const [draft, setDraftState] = useState(pad.content);
  const [base, setBase] = useState({ content: pad.content, revision: pad.revision });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(pad.content);
  const dirty = draft !== base.content;

  useEffect(() => {
    // After a save the base is ahead of the pad until the refetch lands; following the older pad
    // would flash the previous version.
    if (pad.revision <= base.revision) return;
    // A title, tag or project change bumps the revision without touching the file, so an open
    // draft still applies on top of it.
    if (pad.content === base.content) {
      setBase({ content: pad.content, revision: pad.revision });
      return;
    }
    if (current.current !== base.content) return;
    current.current = pad.content;
    setDraftState(pad.content);
    setBase({ content: pad.content, revision: pad.revision });
  }, [pad.content, pad.revision, base]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const setDraft = useCallback((next: string) => {
    current.current = next;
    setDraftState(next);
  }, []);

  async function save(): Promise<void> {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    const submitted = current.current;
    try {
      const saved = await api.scratchpads.update(pad.id, {
        content: submitted,
        if_revision: base.revision,
      });
      setBase({ content: saved.content, revision: saved.revision });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save scratchpad");
    } finally {
      setSaving(false);
      // On a conflict this loads the other writer's version for Discard.
      await invalidate();
    }
  }

  /** Keep this draft over the other writer's version; the next save replaces theirs. */
  function overwrite(): void {
    setBase({ content: pad.content, revision: pad.revision });
    setError(null);
  }

  function discard(): void {
    current.current = pad.content;
    setDraftState(pad.content);
    setBase({ content: pad.content, revision: pad.revision });
    setError(null);
  }

  return {
    draft,
    setDraft,
    dirty,
    /** The pad moved on while this draft was open; saving will report a conflict. */
    stale: dirty && pad.revision !== base.revision,
    saving,
    error,
    save,
    overwrite,
    discard,
  };
}

export type PadDraft = ReturnType<typeof usePadDraft>;
