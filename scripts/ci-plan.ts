import {
  affectedTestFiles,
  type DomainSelection,
  isSourceFile,
  readPackageDomains,
} from "./ci-domains.js";

export type Step = [string, string[]];

export function typecheckSteps(selection: DomainSelection | undefined): Step[] {
  if (!selection || selection.runAll)
    return [["Typecheck", ["bun", "run", "--sequential", "--filter", "*", "typecheck"]]];
  return selection.packageNames.map((name) => [
    `Typecheck ${name}`,
    ["bun", "run", "--filter", name, "typecheck"],
  ]);
}

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
    const direct = new Set(selection.directNames);
    const packageFilesOnlySource = selection.changedPaths
      .filter((path) => path.startsWith("packages/"))
      .every(isSourceFile);
    for (const domain of readPackageDomains(root)) {
      if (!selected.has(domain.name) || !domain.hasTestScript) continue;
      if (direct.has(domain.name) || !packageFilesOnlySource) {
        steps.push(
          domain.name === "@orc/web"
            ? webUnit
            : [`Test ${domain.name}`, ["bun", "run", "--filter", domain.name, "test"]],
        );
        continue;
      }
      const files = affectedTestFiles(root, domain.folder, selection.changedPaths);
      if (files.length === 0) continue;
      // A direct `bun test` never reads the package's test script, so a package
      // that serializes there (process-global fixture state) must serialize here too.
      steps.push([
        `Test ${domain.name} affected files`,
        [
          "bun",
          "--cwd",
          `packages/${domain.folder}`,
          "test",
          ...(domain.serialTests ? ["--max-concurrency=1"] : []),
          ...files,
        ],
      ]);
    }
  }
  const webSelected = !selection || selection.packageNames.includes("@orc/web");
  if (options.e2e && webSelected) steps.push(webE2e);
  else if (options.sanity || options.e2e) steps.push(sanityE2e);
  return steps;
}
