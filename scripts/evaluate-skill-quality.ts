/** Paid paired real-agent evaluation. Preserves all attempts; never manufactures gains. */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type AgentEvent, createBackend } from "../packages/agent-runtime/src/index.js";
import { loadConfig } from "../packages/core/src/config.js";
import { closeDb, getSqlite } from "../packages/db/src/client.js";
import { PassageIndex } from "../packages/db/src/retrieval.js";
import { getSkillSnapshot } from "../packages/db/src/skill-evolution.js";
import { WikiStore } from "../packages/db/src/wiki.js";

const directory = resolve(import.meta.dir, "../.claude/tooling/skill-quality", String(Date.now()));
mkdirSync(directory, { recursive: true });
loadConfig({ db: { path: join(directory, "orc.db") }, rules: { enabled: false } });
const db = getSqlite();
const wiki = new WikiStore(db);
const index = new PassageIndex(db);
const additions: Record<string, string> = {
  "orc-reviewer":
    "\n\n## Evidence before review findings\nTrace each changed function through its actual callers and input/storage boundaries. Verify the expected deployment load before reporting a scale issue. A blocking finding needs an executable trigger or exact input, the affected caller/path, the failure and a bounded fix. Check the full connected files rather than treating the diff as the entire behavior. Separate reproduced failures from unverified suspicions and personal style preferences. State what could not be executed.\n",
  "orc-worker-base":
    "\n\n## Reuse before implementation\nInspect the existing callers, shared helpers, tests and exports before selecting a fix. Prefer the existing project helper, then a platform facility, then an installed dependency; add code only when those cannot complete the requirement. Fix a repeated failure once in the shared implementation. Finish every affected caller and keep its validation and data-loss handling. Use a focused check that fails on the actual defect, and record checks not run.\n",
};
type Case = {
  id: string;
  files: Record<string, string>;
  task: string;
  check?: string;
  expectedFile?: string;
  pattern?: string;
  clean?: boolean;
};
const workerCases: Case[] = [
  {
    id: "wk-scope",
    files: {
      "subject.ts":
        "export function neighbors(rows:any[],project:string|null){return rows.slice(0,2)}",
    },
    task: "Fix neighbors so it returns at most two entries from the requested project (including null). Keep the signature and input order.",
    check:
      "const rows=[{project:'b'},{project:'a'},{project:null},{project:'a'}]; assert.deepEqual(m.neighbors(rows,'a'),[rows[1],rows[3]]);assert.deepEqual(m.neighbors(rows,null),[rows[2]]);",
  },
  {
    id: "wk-expiry",
    files: {
      "subject.ts":
        "export function eligible(rows:any[],now:number){return rows.filter(r=>r.expiry)}",
    },
    task: "Fix eligible: expiry null means no expiry, and an expiry equal to now or earlier is expired.",
    check:
      "const rows=[{expiry:null},{expiry:10},{expiry:11},{expiry:0}];assert.deepEqual(m.eligible(rows,10),[rows[0],rows[2]]);",
  },
  {
    id: "wk-priority",
    files: {
      "subject.ts":
        "export function context(rows:any[],limit:number){return rows.slice(0,limit).sort((a,b)=>b.priority-a.priority)}",
    },
    task: "Fix context so the highest-priority entries win before applying limit. Do not mutate the input.",
    check:
      "const rows=[{priority:1},{priority:9},{priority:5}];assert.deepEqual(m.context(rows,1),[rows[1]]);assert.deepEqual(rows.map(x=>x.priority),[1,9,5]);",
  },
  {
    id: "wk-shared",
    files: {
      "subject.ts":
        "import {normalize} from './shared';export function one(s:string){return normalize(s)}export function two(s:string){return normalize(s)}",
      "shared.ts": "export function normalize(s:string){return s.trim()}",
    },
    task: "Both one and two must trim and lowercase their input. Correct the shared behavior while preserving the callers.",
    check: "assert.equal(m.one(' A '),'a');assert.equal(m.two(' B '),'b');",
  },
  {
    id: "wk-copy",
    files: {
      "subject.ts": "export function sorted(values:number[]){return values.sort((a,b)=>a-b)}",
    },
    task: "Fix sorted to sort ascending without mutating the caller's array.",
    check: "const xs=[3,1,2];assert.deepEqual(m.sorted(xs),[1,2,3]);assert.deepEqual(xs,[3,1,2]);",
  },
  {
    id: "wk-limit",
    files: { "subject.ts": "export function validLimit(n:number){return n>0&&n<=100}" },
    task: "validLimit must only accept integer numbers from 1 through 100. Reject NaN, infinities and fractions.",
    check:
      "for(const n of [NaN,Infinity,-Infinity,0,-1,1.5,101])assert.equal(m.validLimit(n),false);for(const n of [1,50,100])assert.equal(m.validLimit(n),true);",
  },
  {
    id: "wk-path",
    files: {
      "subject.ts": "export function inside(root:string,path:string){return path.startsWith(root)}",
    },
    task: "Fix inside for absolute filesystem paths: allow the root and descendants, reject siblings whose names share the prefix and paths escaping via .. . Use the platform path library.",
    check:
      "const path=await import('node:path');const root=path.resolve('safe');assert.equal(m.inside(root,path.join(root,'a')),true);assert.equal(m.inside(root,root),true);assert.equal(m.inside(root,root+'-other'),false);assert.equal(m.inside(root,path.join(root,'..','other')),false);",
  },
  {
    id: "wk-dedup",
    files: {
      "subject.ts":
        "export function contribute(ids:Set<string>,id:string){ids.add(id);return true}",
    },
    task: "Fix contribute: add a new id and return true once; repeated identical ids return false without changing the set.",
    check:
      "const ids=new Set();assert.equal(m.contribute(ids,'a'),true);assert.equal(m.contribute(ids,'a'),false);assert.equal(m.contribute(ids,'b'),true);assert.equal(ids.size,2);",
  },
  {
    id: "wk-empty",
    files: {
      "subject.ts": "export function title(value:string|null){return value!.trim()||'Untitled'}",
    },
    task: "title should return Untitled for null or a blank string; otherwise return the trimmed value.",
    check:
      "assert.equal(m.title(null),'Untitled');assert.equal(m.title('  '),'Untitled');assert.equal(m.title(' Name '),'Name');",
  },
  {
    id: "wk-boundary",
    files: {
      "subject.ts":
        "export function page(xs:number[],offset:number,limit:number){return xs.slice(offset,limit)}",
    },
    task: "Fix page to return up to limit elements starting at offset. Assume nonnegative integer arguments. Keep empty/end boundaries correct.",
    check:
      "assert.deepEqual(m.page([0,1,2,3,4],2,2),[2,3]);assert.deepEqual(m.page([0,1],2,2),[]);assert.deepEqual(m.page([0,1],0,0),[]);",
  },
];
const reviewCases: Case[] = [
  {
    id: "rv-expiry",
    files: {
      "subject.ts":
        "export function eligible(x:any,now:number){return x.expiry===null||x.expiry>=now}",
      "caller.ts":
        "import {eligible} from './subject'; export const atBoundary=eligible({expiry:10},10);",
    },
    task: "Review eligible. Contract: expiry equal to now is expired. The caller runs on every search.",
    expectedFile: "subject.ts",
    pattern: "equal|boundar|>=|expir",
  },
  {
    id: "rv-scope",
    files: {
      "subject.ts": "export function neighbors(rows:any[],id:string){return rows.slice(0,3)}",
      "caller.ts":
        "import {neighbors} from './subject';export const result=neighbors([{project:'a'},{project:'b'}],'a');",
    },
    task: "Review project-isolated neighbors. Data can include several projects.",
    expectedFile: "subject.ts",
    pattern: "project|filter|isolat",
  },
  {
    id: "rv-context",
    files: {
      "subject.ts":
        "export function select(rows:any[]){return rows.slice(0,5).sort((a,b)=>b.importance-a.importance)}",
    },
    task: "Review startup selection. Critical entries can appear late in rows.",
    expectedFile: "subject.ts",
    pattern: "slice|limit|before|priorit|sort",
  },
  {
    id: "rv-path",
    files: {
      "subject.ts":
        "export function allowed(root:string,file:string){return file.startsWith(root)}",
      "caller.ts":
        "import {allowed} from './subject'; export const canWrite=allowed('/safe','/safe-evil/secret');",
    },
    task: "Review this filesystem authorization check with attacker-controlled absolute paths.",
    expectedFile: "subject.ts",
    pattern: "prefix|sibling|safe-evil|travers|boundar",
  },
  {
    id: "rv-injection",
    files: {
      "subject.ts":
        // biome-ignore lint/suspicious/noTemplateCurlyInString: seeded insecure source code, not evaluated here
        "export function find(db:any,id:string){return db.query(`SELECT * FROM accounts WHERE id='${id}'`).get()}",
    },
    task: "Review find, called with an untrusted HTTP query parameter.",
    expectedFile: "subject.ts",
    pattern: "inject|parameter|bind|SQL",
  },
  {
    id: "rv-mutation",
    files: {
      "subject.ts": "export function top(xs:number[]){return xs.sort((a,b)=>b-a)[0]}",
      "caller.ts":
        "import {top} from './subject';const events=[1,3,2];top(events);export const firstEvent=events[0];",
    },
    task: "Review top and its caller. The caller must retain chronological order.",
    expectedFile: "subject.ts",
    pattern: "mutat|in.place|sort|order",
  },
  {
    id: "rv-auth",
    files: {
      "subject.ts":
        "export function authorize(expected:string,provided:string|undefined){if(!provided)return true;return expected===provided}",
    },
    task: "Review authorization. expected is a configured nonempty bearer secret.",
    expectedFile: "subject.ts",
    pattern: "missing|absent|without|unauth|bypass|true",
  },
  {
    id: "rv-dedup",
    files: {
      "subject.ts":
        "export async function enqueue(db:any,key:string){if(await db.has(key))return;await db.insert(key);await db.dispatch(key)}",
    },
    task: "Review idempotency. Two concurrent processes share the DB and insert has no unique constraint.",
    expectedFile: "subject.ts",
    pattern: "race|concurr|atomic|unique|check.then",
  },
  {
    id: "rv-clean-scope",
    files: {
      "subject.ts":
        "export function neighbors(rows:{project:string|null}[],project:string|null){return rows.filter(r=>r.project===project).slice(0,3)}",
    },
    task: "Review for correctness and project isolation. This runs for one user over a bounded list of 20 rows; no throughput requirement beyond that.",
    clean: true,
  },
  {
    id: "rv-clean-copy",
    files: { "subject.ts": "export function sorted(xs:number[]){return [...xs].sort((a,b)=>a-b)}" },
    task: "Review for correctness. The contract is an ascending copy without input mutation. Input is a small finite number array.",
    clean: true,
  },
];

type Run = {
  passed: boolean;
  workspace: string;
  elapsed_ms: number;
  skill_hash: string;
  events: AgentEvent[];
  error?: string;
};
async function runCase(c: Case, skill: string, arm: string, name: string): Promise<Run> {
  const workspace = mkdtempSync(join(tmpdir(), `orc-quality-${arm}-`));
  for (const [file, content] of Object.entries(c.files))
    writeFileSync(join(workspace, file), content);
  const events: AgentEvent[] = [];
  const started = Date.now();
  const reviewer = name === "orc-reviewer";
  const session = await createBackend("claude").startSession({
    cwd: workspace,
    autoApprove: true,
    toolAllowlist: reviewer
      ? ["Read", "Glob", "Grep"]
      : ["Read", "Glob", "Grep", "Edit", "Write", "Bash"],
    systemPromptAppend: `${skill}\n\nEvaluation host instructions: This is an isolated standalone evaluation, not an ORC task node. ORC MCP, task status and git workflows are unavailable and not required. Only inspect/modify the supplied workspace. Do not access network or other directories. ${reviewer ? 'Do not modify code. Return only JSON {"blocking":[{"file":"relative path","reason":"concrete input and failure"}],"nonblocking":[]}. An empty blocking array is a valid review.' : "Implement the task and run a meaningful local check. Keep the exported signatures. Do not change unrelated code. Stop when complete."}`,
  });
  const timer = setTimeout(() => {
    void session.close();
  }, 150_000);
  let passed = false;
  let error: string | undefined;
  try {
    await session.send(c.task);
    for await (const event of session.events()) events.push(event);
    if (events.some((e) => e.type === "error") || !events.some((e) => e.type === "result"))
      throw new Error("Agent did not finish successfully");
    if (reviewer) {
      const text = events
        .filter((e): e is Extract<AgentEvent, { type: "text" }> => e.type === "text")
        .map((e) => e.data)
        .join("\n");
      const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as {
        blocking?: { file: string; reason: string }[];
      };
      if (!Array.isArray(json.blocking)) throw new Error("Review lacks structured findings");
      passed = c.clean
        ? json.blocking.length === 0
        : json.blocking.some(
            (f) =>
              f.file.endsWith(c.expectedFile ?? "") &&
              new RegExp(c.pattern ?? "", "i").test(f.reason),
          );
    } else {
      const checks = `import assert from 'node:assert/strict';const m=await import(${JSON.stringify(join(workspace, "subject.ts"))});${c.check}`;
      const proc = Bun.spawn([process.execPath, "--eval", checks], {
        cwd: workspace,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15000,
        windowsHide: true,
      });
      const stderr = await new Response(proc.stderr).text();
      passed = (await proc.exited) === 0;
      if (!passed) error = stderr.slice(0, 4000);
    }
  } catch (e) {
    error = String(e);
  } finally {
    clearTimeout(timer);
    await session.close();
  }
  const result: Run = {
    passed,
    workspace,
    elapsed_ms: Date.now() - started,
    skill_hash: createHash("sha256").update(skill).digest("hex"),
    events,
    ...(error ? { error } : {}),
  };
  writeFileSync(join(directory, `${name}-${c.id}-${arm}.json`), JSON.stringify(result, null, 2));
  return result;
}

try {
  const source = {
    kind: "document" as const,
    source_id: "ponytail-quality-research",
    project_id: null,
    title: "Ponytail quality research and bounded candidate rationale",
    content: readFileSync(resolve(import.meta.dir, "../docs/agent-rules.md"), "utf8"),
    location:
      "https://github.com/DietrichGebert/ponytail/tree/9cc65d03aa2da1db7121b912d03596409ee340b8",
    tags: ["skills", "evaluation"],
    metadata: { upstream_revision: "9cc65d03aa2da1db7121b912d03596409ee340b8" },
  };
  index.put(source);
  const evidence = (
    await index.search({ query: "Ponytail review candidate", project_id: null, limit: 5 })
  ).passages.map((p) => p.id);
  const summary: unknown[] = [];
  for (const name of ["orc-reviewer", "orc-worker-base"]) {
    const baseline = getSkillSnapshot(db, name, null);
    const candidate = baseline.raw + additions[name];
    const proposal = wiki.propose({
      project_id: null,
      skill_name: name,
      baseline_hash: baseline.hash,
      candidate,
      rationale:
        "Evaluate bounded Ponytail-inspired reuse and connected-code evidence guidance with executable fixtures; preserve failed/no-gain outcomes.",
      evidence,
      training_cases: [],
    });
    const cases = name === "orc-reviewer" ? reviewCases : workerCases;
    const outcomes: { id: string; baseline: boolean; candidate: boolean }[] = [];
    let completedRuns = 0;
    for (const [number, c] of cases.entries()) {
      const baselineFirst = number % 2 === 0;
      const first = await runCase(
        c,
        baselineFirst ? baseline.raw : candidate,
        baselineFirst ? "baseline" : "candidate",
        name,
      );
      const second = await runCase(
        c,
        baselineFirst ? candidate : baseline.raw,
        baselineFirst ? "candidate" : "baseline",
        name,
      );
      for (const run of [first, second]) {
        if (
          !run.events.some((event) => event.type === "error") &&
          run.events.some((event) => event.type === "result")
        )
          completedRuns++;
      }
      outcomes.push({
        id: c.id,
        baseline: (baselineFirst ? first : second).passed,
        candidate: (baselineFirst ? second : first).passed,
      });
      console.log(JSON.stringify({ name, case: c.id, ...outcomes.at(-1) }));
      writeFileSync(
        join(directory, `${name}-progress.json`),
        JSON.stringify({ proposal, outcomes }, null, 2),
      );
    }
    const result = wiki.evaluate({
      proposal_id: proposal,
      project_id: null,
      suite: "orc-quality-real-agent-v1",
      cases: outcomes,
      validation_passed: completedRuns === cases.length * 2,
      notes: `Completed ${completedRuns}/${cases.length * 2} agent runs. Real paired runs in independent temporary directories, alternating arm order; raw events, actual injected hashes and worker executable checks retained. Reviewer grading checks structured concrete findings for seeded defects plus two clean controls. One run per case/arm; narrow diagnostic suite, not a representative/statistical guarantee or unqualified production performance claim.`,
    });
    summary.push({ name, proposal, result, completedRuns, outcomes });
    writeFileSync(join(directory, "report.json"), JSON.stringify(summary, null, 2));
  }
  console.log(`Retained real skill outcomes: ${directory}`);
} finally {
  closeDb();
}
