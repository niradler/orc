import { HelpPopover } from "@/components/HelpPopover";

/** Long guidance for the inspector's Changes tab, kept in the shared help popover. */
export function InspectorChangesHelp() {
  return (
    <HelpPopover label="Changes" testId="inspector-changes-help">
      Shows the working-tree changes of the terminal running in this session&apos;s folder. Select
      files to stage and commit them here. When the branch has an open pull request, switch to
      <strong> PR</strong> to review its diff and comments, or open it on GitHub.
    </HelpPopover>
  );
}
