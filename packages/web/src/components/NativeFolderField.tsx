import { useRef, useState } from "react";
import { FolderPickerDialog } from "@/components/FolderPickerDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type TransferMatch = { name: string; level: string; score: number; where: string };

/** "Near copy of build-cmd in ORC (97%)" for a dedup match. */
export function matchText(match: TransferMatch, folder = "the folder"): string {
  const level =
    match.level === "identical"
      ? "Identical to"
      : match.level === "near"
        ? "Near copy of"
        : "Similar to";
  const where = match.where === "orc" ? "in ORC" : `in ${folder}`;
  return `${level} ${match.name} ${where} (${Math.round(match.score * 100)}%)`;
}

export function MatchNote({ match, folder }: { match?: TransferMatch; folder?: string }) {
  if (!match) return null;
  return (
    <span className="block text-xs text-warning wrap-break-word" data-testid="transfer-match">
      {matchText(match, folder)}
    </span>
  );
}

/** Absolute folder path on the API host, typed or picked with the shared folder picker. */
export function NativeFolderField({
  id,
  label,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (path: string) => void;
  disabled?: boolean;
}) {
  const [browsing, setBrowsing] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id={id}
          data-testid={id}
          value={value}
          disabled={disabled}
          placeholder="Absolute folder path on the API host"
          onChange={(event) => onChange(event.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          ref={trigger}
          data-testid={`${id}-browse`}
          disabled={disabled}
          onClick={() => setBrowsing(true)}
        >
          Browse
        </Button>
      </div>
      <FolderPickerDialog
        open={browsing}
        onOpenChange={setBrowsing}
        host={null}
        initial={value}
        onPick={onChange}
        returnFocusRef={trigger}
      />
    </div>
  );
}
