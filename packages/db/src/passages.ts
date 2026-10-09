import { createHash } from "node:crypto";
import type { EvidenceSource, Passage } from "@orc/core/retrieval";
import { EvidenceSourceSchema, normalizeTags } from "@orc/core/retrieval";

export function evidenceVersion(source: EvidenceSource): string {
  return createHash("sha256")
    .update(JSON.stringify(EvidenceSourceSchema.parse(source)))
    .digest("hex");
}

export function segmentEvidence(input: EvidenceSource, maxChars = 2400): Passage[] {
  const source = EvidenceSourceSchema.parse(input);
  if (!Number.isInteger(maxChars) || maxChars < 128)
    throw new Error("Passage size must be at least 128 characters");
  const version = evidenceVersion(source);
  const headings: string[] = [];
  const passages: Passage[] = [];
  const structures: { start: number; end: number; context: string }[] = [];
  let openFence: { start: number; marker: string; context: string } | undefined;
  let table: { start: number; end: number; context: string } | undefined;
  for (const match of source.content.matchAll(/[^\n]*(?:\n|$)/g)) {
    const line = match[0];
    if (!line) continue;
    const marker = /^\s*(`{3,}|~{3,})(.*)/.exec(line);
    if (marker) {
      if (!openFence)
        openFence = {
          start: match.index,
          marker: marker[1] ?? "```",
          context: `Code block ${marker[2]?.trim() ?? ""}`.trim(),
        };
      else if (
        marker[1]?.[0] === openFence.marker[0] &&
        (marker[1]?.length ?? 0) >= openFence.marker.length
      ) {
        structures.push({
          start: openFence.start,
          end: match.index + line.length,
          context: openFence.context,
        });
        openFence = undefined;
      }
    }
    if (!openFence && line.includes("|")) {
      if (!table)
        table = { start: match.index, end: match.index + line.length, context: line.trim() };
      else table.end = match.index + line.length;
    } else if (table) {
      structures.push({ ...table, context: `Table header: ${table.context}` });
      table = undefined;
    }
  }
  if (openFence)
    structures.push({
      start: openFence.start,
      end: source.content.length,
      context: openFence.context,
    });
  if (table) structures.push({ ...table, context: `Table header: ${table.context}` });
  let start = 0;
  let end = 0;
  let fenced = false;
  let fence = "";
  let passageHeadings: string[] = [];

  function emit(): void {
    if (end <= start || !source.content.slice(start, end).trim()) return;
    let position = start;
    while (position < end) {
      let stop = Math.min(position + maxChars, end);
      if (stop < end) {
        const newline = source.content.lastIndexOf("\n", stop - 1);
        if (newline > position + maxChars / 2) stop = newline + 1;
      }
      const ordinal = passages.length;
      passages.push({
        id: createHash("sha256")
          .update(`${source.kind}:${source.source_id}:${version}:${ordinal}`)
          .digest("hex"),
        source_id: source.source_id,
        version,
        kind: source.kind,
        project_id: source.project_id,
        title: source.title,
        location: source.location,
        headings: [...passageHeadings],
        structural_context:
          structures.find((structure) => position >= structure.start && position < structure.end)
            ?.context ?? null,
        start: position,
        end: stop,
        content: source.content.slice(position, stop),
        ordinal,
        tags: normalizeTags(source.tags),
      });
      position = stop;
    }
  }

  for (const match of source.content.matchAll(/[^\n]*(?:\n|$)/g)) {
    const line = match[0];
    if (!line) continue;
    const position = match.index;
    const heading = !fenced ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.trimEnd()) : null;
    if (heading) {
      emit();
      start = position;
      headings.length = (heading[1]?.length ?? 1) - 1;
      headings.push(heading[2] ?? "");
      passageHeadings = headings.filter(Boolean);
    } else if (!fenced && !line.trim() && position - start >= maxChars / 2) {
      emit();
      start = position;
      passageHeadings = headings.filter(Boolean);
    }
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fenced) {
        fenced = true;
        fence = marker;
      } else if (marker[0] === fence[0] && marker.length >= fence.length) fenced = false;
    }
    end = position + line.length;
  }
  emit();
  return passages;
}
