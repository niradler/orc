import { type DomainSelection, readPackageDomains } from "./ci-domains.js";

export type Step = [string, string[]];

export function packageTestSteps(
  root: string,
  selection: DomainSelection | undefined,
  options: { e2e: boolean; sanity: boolean },
): Step[] {
  const steps: Step[] = [];
  const webUnit: Step = ["Web unit tests", ["bun", "run", "--filter", "@orc/web", "test:unit"]];
  const webE2e: Step = ["Web e2e", ["bun", "packages/web/scripts/run-e2e.ts"]];
  const sanityE2e: Step = [
    "Sanity e2e",
    ["bun", "packages/web/scripts/run-e2e.ts", "--grep", "@sanity"],
  ];
  if (!selection || selection.runAll) {
    steps.push(["Test", ["bun", "run", "--sequential", "--filter", "!@orc/web", "test"]], webUnit);
  } else {
    const selected = new Set(selection.packageNames);
    for (const domain of readPackageDomains(root)) {
      if (!selected.has(domain.name) || !domain.hasTestScript || domain.name === "@orc/web")
        continue;
      steps.push([`Test ${domain.name}`, ["bun", "run", "--filter", domain.name, "test"]]);
    }
    if (selected.has("@orc/web")) steps.push(webUnit);
  }
  const webSelected = !selection || selection.packageNames.includes("@orc/web");
  if (options.e2e && webSelected) steps.push(webE2e);
  else if (options.sanity || options.e2e) steps.push(sanityE2e);
  return steps;
}
