import { HelpPopover } from "@/components/HelpPopover";

/** Long guidance for the inspector's Changes tab, kept in the shared help popover. */
export function InspectorChangesHelp() {
  return (
    <HelpPopover label="Changes" testId="inspector-changes-help">
      Working-tree changes in this session's folder. Select files to stage and commit. With an open
      PR, switch to <strong>PR</strong> for its diff and comments.
    </HelpPopover>
  );
}
