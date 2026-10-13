import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// Nothing a pull request or a dry run starts may publish: no GitHub release, update feed, Store
// submission, version commit or website. release-plan.ts makes every pull request event a dry run
// (test/release.test.ts holds it to that); this holds the workflows to the rest by evaluating
// their actual `if:` conditions. For every event a release run starts on, plan output and result
// of the jobs a publishing call waits for, it works out which of release.yml's calls of
// publish.yml start and, inside each, which of publish.yml's jobs would run, assuming every job
// that runs succeeds and reports the outputs that let the next one go on. actionlint checks the
// rest of the YAML; docs/maintainers/ci.md traces each path.

interface Job {
  readonly if?: string;
  readonly needs?: string | readonly string[];
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
}

interface Workflow {
  readonly on: Record<string, unknown>;
  readonly jobs: Record<string, Job>;
}

const read = (name: string): Workflow =>
  parse(readFileSync(`.github/workflows/${name}`, "utf8")) as Workflow;
const PUBLISH = "./.github/workflows/publish.yml";

// A GitHub Actions expression evaluator for the subset these conditions use: string literals,
// context paths such as needs.plan.outputs.dry-run, the status functions, !, ==, !=, && and ||
// with parentheses, at GitHub's precedence. Comparisons follow GitHub's loose rules: strings
// compare without case, anything else as numbers, with null and '' as 0.

type Value = string | number | boolean | null;

/** What an expression reads: context paths, and whether the job's needs all succeeded. */
interface Scope {
  readonly path: (path: string) => Value;
  readonly success: boolean;
}

const TOKEN = /\s*(\(|\)|==|!=|&&|\|\||!|'(?:[^']|'')*'|[A-Za-z_][\w.-]*)/y;

function tokenize(expression: string): string[] {
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < expression.trimEnd().length) {
    const match = TOKEN.exec(expression);
    if (!match) throw new Error(`Can't read ${JSON.stringify(expression)} past ${TOKEN.lastIndex}`);
    tokens.push(match[1]!);
  }
  return tokens;
}

const truthy = (value: Value) => value !== null && value !== false && value !== 0 && value !== "";
const number = (value: Value) =>
  value === null ? 0 : typeof value === "boolean" ? Number(value) : Number(value || 0);
const equal = (a: Value, b: Value) =>
  typeof a === "string" && typeof b === "string"
    ? a.toLowerCase() === b.toLowerCase()
    : number(a) === number(b);

const STATUS = ["success", "failure", "always", "cancelled"];

/** Evaluates `expression` as a job's `if:`, adding GitHub's implicit success() when it names none. */
function runs(expression: string | undefined, scope: Scope): boolean {
  const source = expression ?? "success()";
  const tokens = tokenize(source);
  const status = tokens.some((token, index) => STATUS.includes(token) && tokens[index + 1] === "(");
  let at = 0;
  const peek = () => tokens[at];
  const take = (expected?: string) => {
    const token = tokens[at++];
    if (token === undefined || (expected && token !== expected))
      throw new Error(`Expected ${expected ?? "more"} in ${source}`);
    return token;
  };
  const primary = (): Value => {
    const token = take();
    if (token === "(") {
      const value = or();
      take(")");
      return value;
    }
    if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
    if (peek() === "(") {
      take("(");
      take(")");
      if (token === "success") return scope.success;
      if (token === "cancelled") return false;
      if (token === "always") return true;
      if (token === "failure") return false;
      throw new Error(`Unknown function ${token}()`);
    }
    if (token === "true" || token === "false") return token === "true";
    if (token === "null") return null;
    return scope.path(token);
  };
  const unary = (): Value => (peek() === "!" ? (take(), !truthy(unary())) : primary());
  const comparison = (): Value => {
    const left = unary();
    const operator = peek();
    if (operator !== "==" && operator !== "!=") return left;
    take();
    const same = equal(left, unary());
    return operator === "==" ? same : !same;
  };
  const and = (): Value => {
    let value = comparison();
    while (peek() === "&&") {
      take();
      const right = comparison();
      value = truthy(value) ? right : value;
    }
    return value;
  };
  const or = (): Value => {
    let value = and();
    while (peek() === "||") {
      take();
      const right = and();
      value = truthy(value) ? value : right;
    }
    return value;
  };
  const value = or();
  if (at !== tokens.length) throw new Error(`Unread ${tokens.slice(at).join(" ")} in ${source}`);
  return truthy(value) && (status || scope.success);
}

const needsOf = (job: Job) =>
  job.needs === undefined ? [] : typeof job.needs === "string" ? [job.needs] : job.needs;

/** A context path's value, from the leaves given; anything not given reads as null. */
const lookup =
  (values: Record<string, Value>) =>
  (path: string): Value =>
    values[path] ?? null;

/**
 * The jobs of `workflow` that run, in an order that respects their needs, when `context` answers
 * every path but a job's needs: a job that ran succeeded and reports "true" for every output.
 */
function simulate(workflow: Workflow, context: Record<string, Value>): string[] {
  const results = new Map<string, "success" | "skipped">();
  const pending = Object.keys(workflow.jobs);
  while (pending.length > 0) {
    const index = pending.findIndex((name) =>
      needsOf(workflow.jobs[name]!).every((need) => results.has(need)),
    );
    if (index === -1) throw new Error(`A cycle among ${pending.join(", ")}`);
    const [name] = pending.splice(index, 1);
    const job = workflow.jobs[name!]!;
    const needs = needsOf(job);
    const path = (path: string): Value => {
      const [scope, need, kind] = path.split(".");
      if (scope !== "needs") return lookup(context)(path);
      if (kind === "result") return results.get(need!) ?? null;
      return results.get(need!) === "success" ? "true" : null;
    };
    const ran = runs(job.if, {
      path,
      success: needs.every((need) => results.get(need) === "success"),
    });
    results.set(name!, ran ? "success" : "skipped");
  }
  return [...results].flatMap(([name, result]) => (result === "success" ? [name] : []));
}

const RESULTS = ["success", "failure", "skipped", "cancelled"] as const;

/** Every combination of the values given for each key. */
function* combinations<T>(choices: Record<string, readonly T[]>): Generator<Record<string, T>> {
  const [first, ...rest] = Object.entries(choices);
  if (!first) return yield {};
  for (const value of first[1])
    for (const others of combinations(Object.fromEntries(rest)))
      yield { [first[0]]: value, ...others };
}

/**
 * Which of publish.yml's jobs run, per release.yml call that starts, for one release run: the
 * event that started it, its plan's dry-run output and channel, and each needed job's result.
 */
function publishedBy(release: Workflow, publish: Workflow, run: Record<string, string>) {
  const published: Record<string, string[]> = {};
  for (const [name, job] of Object.entries(release.jobs)) {
    if (job.uses !== PUBLISH) continue;
    const needs = needsOf(job).filter((need) => need !== "plan");
    const path = (path: string): Value => {
      if (path === "github.event_name") return run["event"]!;
      if (path === "needs.plan.outputs.dry-run") return run["dry-run"]!;
      if (path === "needs.plan.result") return "success";
      const [scope, need, kind] = path.split(".");
      if (scope === "needs" && kind === "result") return run[need!] ?? null;
      // Every other plan output and package output names something.
      if (scope === "needs") return "x";
      return null;
    };
    const success = needs.every((need) => run[need] === "success");
    if (!runs(job.if, { path, success })) continue;
    published[name] = simulate(publish, {
      "github.event_name": run["event"]!,
      "github.ref": "refs/heads/main",
      // A release's call names its release; it names no target.
      "inputs.tag": "v0.0.13",
      "inputs.version": "0.0.13",
      "inputs.sha": "0123456789abcdef0123456789abcdef01234567",
      "inputs.channel": run["channel"]!,
      // Worst case: every surface turned on.
      "vars.MARKETING_DEPLOY_ENABLED": "true",
      "vars.STORE_AUTOMATION_ENABLED": "true",
    });
  }
  return published;
}

/** Every release run a dry run or pull request event could start, with each needed job's result. */
function* guardedRuns(release: Workflow) {
  const needed = new Set(
    Object.values(release.jobs)
      .filter((job) => job.uses === PUBLISH)
      .flatMap(needsOf)
      .filter((need) => need !== "plan"),
  );
  for (const run of combinations({
    event: ["schedule", "workflow_dispatch", "pull_request"],
    "dry-run": ["true", "false"],
    channel: ["nightly", "stable"],
    ...Object.fromEntries([...needed].map((need) => [need, RESULTS])),
  })) {
    if (run["dry-run"] === "true" || run["event"] === "pull_request") yield run;
  }
}

/** The publications any guarded run starts, or none. */
function leaks(release: Workflow, publish: Workflow) {
  for (const run of guardedRuns(release)) {
    const published = publishedBy(release, publish, run);
    if (Object.values(published).some((jobs) => jobs.length > 0)) return { run, published };
  }
  return null;
}

const release = read("release.yml");
const publish = read("publish.yml");

describe("publishing", () => {
  it("never starts on a pull request event of its own", () => {
    expect(Object.keys(publish.on)).toEqual(["workflow_call", "push", "workflow_dispatch"]);
  });

  it("runs no job of a release's call for a dry run or a pull request event, whatever else happened", () => {
    expect(leaks(release, publish)).toBeNull();
  });

  it("does publish a scheduled nightly and a stable release once everything they wait for passed", () => {
    const passed = Object.fromEntries(
      Object.values(release.jobs).flatMap((job) => needsOf(job).map((need) => [need, "success"])),
    );
    const nightly = { ...passed, event: "schedule", "dry-run": "false", channel: "nightly" };
    const stable = { ...passed, event: "workflow_dispatch", "dry-run": "false", channel: "stable" };

    expect(publishedBy(release, publish, nightly)["publish"]).toEqual(["release", "feed"]);
    expect(publishedBy(release, publish, stable)["publish"]).toEqual(
      expect.arrayContaining([
        "release",
        "feed",
        "store",
        "finalize",
        "website-publish",
        "indexnow",
      ]),
    );
  });

  it("would catch a call that ignores the plan's dry-run output, or a release job that takes a pull request", () => {
    const ignoring = structuredClone(release);
    const call = ignoring.jobs["publish"] as { if: string };
    call.if = call.if.replace(
      "needs.plan.outputs.dry-run == 'false'",
      "(needs.plan.outputs.dry-run == 'false' || true)",
    );
    expect(leaks(ignoring, publish)).toMatchObject({ run: { "dry-run": "true" } });

    const taking = structuredClone(publish);
    (taking.jobs["release"] as { if: string }).if = "inputs.tag != ''";
    expect(leaks(release, taking)).toMatchObject({
      run: { event: "pull_request", "dry-run": "false" },
    });
  });

  it("is called by no other workflow", () => {
    for (const name of ["checks.yml", "package.yml", "upgrade-check.yml"]) {
      expect(Object.values(read(name).jobs).map((job) => job.uses)).not.toContain(PUBLISH);
    }
  });
});
