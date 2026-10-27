import { ViewHeader } from "@/components/ViewHeader";
import { RulesPanel } from "./RulesPanel";

export default function Rules() {
  return (
    <div data-testid="rules-view">
      <ViewHeader title="Rules" />
      <RulesPanel />
    </div>
  );
}
