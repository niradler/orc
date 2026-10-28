import { ViewHeader } from "@/components/ViewHeader";
import { RulesPanel } from "./RulesPanel";

export default function Rules() {
  return (
    <div data-testid="rules-view">
      <ViewHeader
        title="Rules"
        help="Inspect applied rules and their outcomes by workspace. Rule settings control enforcement and agent assignments."
      />
      <RulesPanel />
    </div>
  );
}
