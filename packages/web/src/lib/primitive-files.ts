import type { SkillFileInput } from "@orc/sdk/types";

export async function readPrimitiveFolder(uploaded: FileList): Promise<SkillFileInput[]> {
  if (uploaded.length > 513) throw new Error("A bundle can include up to 512 supporting files");
  if (Array.from(uploaded).reduce((total, file) => total + file.size, 0) > 16 * 1024 * 1024)
    throw new Error("Bundle exceeds 16 MiB");
  return Promise.all(
    Array.from(uploaded).map(async (file) => {
      const path = file.webkitRelativePath.split("/").slice(1).join("/");
      if (file.size > 8 * 1024 * 1024) throw new Error(`${path} exceeds 8 MiB`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      try {
        const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        if (!content.includes("\0")) return { path, content, encoding: "utf8" };
      } catch {
        // Binary assets need lossless JSON transport.
      }
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return { path, content: btoa(binary), encoding: "base64" };
    }),
  );
}
