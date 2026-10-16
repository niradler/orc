import type { KbDocument } from "@orc/core/kb";
import { useRef, useState } from "react";
import { api } from "@/api/client";
import { useInvalidateKb } from "@/hooks/useKnowledge";

export type KbUpload = {
  id: number;
  kbId: string;
  file: File;
  path?: string;
  /** Replace an uploaded document's file instead of adding a new document. */
  replace?: { document_id: string; expected_revision: number };
  progress: number;
  status: "uploading" | "done" | "failed";
  error?: string | undefined;
  document?: KbDocument;
};

/** Per-file upload queue: each file uploads independently, failures stay listed for retry. */
export function useKbUploads() {
  const invalidate = useInvalidateKb();
  const [uploads, setUploads] = useState<KbUpload[]>([]);
  const nextId = useRef(1);
  const patch = (id: number, change: Partial<KbUpload>) =>
    setUploads((list) => list.map((u) => (u.id === id ? { ...u, ...change } : u)));

  async function run(upload: KbUpload) {
    patch(upload.id, { status: "uploading", progress: 0, error: undefined });
    try {
      const document = await api.kb.upload(
        upload.kbId,
        { file: upload.file, ...(upload.path ? { path: upload.path } : {}), ...upload.replace },
        (progress) => patch(upload.id, { progress }),
      );
      patch(upload.id, { status: "done", progress: 1, document });
      await invalidate();
    } catch (cause) {
      patch(upload.id, {
        status: "failed",
        error: cause instanceof Error ? cause.message : "Upload failed",
      });
    }
  }

  function add(
    kbId: string,
    files: File[],
    options: { folder?: string; replace?: KbUpload["replace"] } = {},
  ) {
    const created = files.map<KbUpload>((file) => ({
      id: nextId.current++,
      kbId,
      file,
      ...(options.folder ? { path: `${options.folder}/${file.name}` } : {}),
      ...(options.replace ? { replace: options.replace } : {}),
      progress: 0,
      status: "uploading",
    }));
    setUploads((list) => [...list, ...created]);
    for (const upload of created) void run(upload);
  }

  return {
    uploads,
    add,
    retry: (id: number) => {
      const upload = uploads.find((u) => u.id === id);
      if (upload) void run(upload);
    },
    clearFinished: () => setUploads((list) => list.filter((u) => u.status === "uploading")),
  };
}
