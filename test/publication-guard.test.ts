import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// Nothing a pull request or a dry run starts may publish: no GitHub release, update feed, Store
// submission, version commit or website. release-plan.ts makes every pull request event a dry run
// (test/release.test.ts holds it to that); this holds release.yml and website.yml to the rest by
// evaluating their actual `if:` conditions, including skipped validation and upgrade jobs. A
// context path it doesn't model fails the test rather than reading as some value.
interface Job {
  readonly "continue-on-error"?: boolean | string;
  readonly if?: string;
  readonly needs?: string | readonly string[];
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
  readonly steps?: readonly {
    readonly id?: string;
    readonly run?: string;
    readonly env?: Record<string, string>;
  }[];
  readonly outputs?: Record<string, unknown>;
}

interface Input {
  readonly type: string;
  readonly default?: unknown;
}

interface Workflow {
  readonly on: {
    readonly workflow_call?: {
      readonly inputs?: Record<string, Input>;
      readonly outputs?: Record<string, unknown>;
    };
    readonly workflow_dispatch?: { readonly inputs?: Record<string, Input> };
  } & Record<string, unknown>;
  readonly jobs: Record<string, Job>;
}

const parsed = new Map<string, Workflow>();
const read = (name: string): Workflow => {
  if (!parsed.has(name))
    parsed.set(name, parse(readFileSync(`.github/workflows/${name}`, "utf8")) as Workflow);
  return parsed.get(name)!;
};

// A GitHub Actions expression evaluator for the subset these conditions use: string literals,
// true, false and null, context paths such as needs.plan.outputs.dry-run, the status functions,
// !, ==, !=, && and || with parentheses, at GitHub's precedence. Comparisons follow GitHub's loose
// rules: strings compare without case, anything else as numbers, with null and '' as 0. A job's
// `if:` without a status function has GitHub's implicit success().

type Value = string | number | boolean | null;

/** What an expression reads: context paths, and the state the status functions report. */
interface Scope {
  /** A context path's value. Throws for a path the test doesn't model. */
  readonly path: (path: string) => Value;
  /** Every job the job needs succeeded. */
  readonly needsSucceeded: boolean;
  /** A job it needs, directly or through others, failed. */
  readonly ancestorFailed: boolean;
  /** The run was cancelled, which a cancelled job's result alone doesn't say. */
  readonly cancelled: boolean;
}

const TOKEN = /\s*(\(|\)|==|!=|&&|\|\||!|'(?:[^']|'')*'|[A-Za-z_][\w.-]*)/y;

const tokenized = new Map<string, string[]>();

function tokenize(expression: string): string[] {
  const known = tokenized.get(expression);
  if (known) return known;
  const tokens: string[] = [];
  const source = expression.trimEnd();
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < source.length) {
    const match = TOKEN.exec(source);
    if (!match) throw new Error(`Can't read ${JSON.stringify(expression)} past ${TOKEN.lastIndex}`);
    tokens.push(match[1]!);
  }
  tokenized.set(expression, tokens);
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

/** The value of `expression` in `scope`. */
function evaluate(expression: string, scope: Scope): Value {
  const tokens = tokenize(expression);
  let at = 0;
  const peek = () => tokens[at];
  const take = (expected?: string) => {
    const token = tokens[at++];
    if (token === undefined || (expected && token !== expected))
      throw new Error(`Expected ${expected ?? "more"} in ${expression}`);
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
      if (token === "success") return scope.needsSucceeded && !scope.cancelled;
      if (token === "failure") return scope.ancestorFailed;
      if (token === "cancelled") return scope.cancelled;
      if (token === "always") return true;
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
  if (at !== tokens.length)
    throw new Error(`Unread ${tokens.slice(at).join(" ")} in ${expression}`);
  return value;
}

/** Whether a job with condition `expression` runs, adding GitHub's implicit success(). */
function runs(expression: string | undefined, scope: Scope): boolean {
  const source = (expression ?? "success()").replace(/^\$\{\{(.*)\}\}$/s, "$1").trim();
  const tokens = tokenize(source);
  const status = tokens.some((token, index) => STATUS.includes(token) && tokens[index + 1] === "(");
  return truthy(evaluate(source, scope)) && (status || evaluate("success()", scope) === true);
}

const needsOf = (job: Job) =>
  job.needs === undefined ? [] : typeof job.needs === "string" ? [job.needs] : job.needs;

/** Every job `name` needs, directly or through the jobs it needs. */
function ancestorsOf(workflow: Workflow, name: string): Set<string> {
  return new Set(
    needsOf(workflow.jobs[name]!).flatMap((need) => [need, ...ancestorsOf(workflow, need)]),
  );
}

type Result = "success" | "failure" | "skipped" | "cancelled";
const RESULTS: readonly Result[] = ["success", "failure", "skipped", "cancelled"];

const unmodelled = (path: string): never => {
  throw new Error(`The guard doesn't model ${path}`);
};

/**
 * The scope of job `name` of `workflow`, given each other job's result and outputs, and `context`
 * for every path outside needs. A needs path for a job it doesn't need, or an output its job
 * doesn't declare, fails.
 */
function jobScope(
  workflow: Workflow,
  name: string,
  results: ReadonlyMap<string, Result>,
  outputs: (job: string, output: string) => Value,
  context: (path: string) => Value,
  cancelled: boolean,
): Scope {
  const needs = needsOf(workflow.jobs[name]!);
  return {
    path: (path) => {
      const [scope, need, kind, output, ...rest] = path.split(".");
      if (scope !== "needs") return context(path);
      if (!need || !needs.includes(need) || rest.length > 0) return unmodelled(path);
      if (kind === "result" && output === undefined) return results.get(need) ?? unmodelled(path);
      if (kind === "outputs" && output !== undefined) return outputs(need, output);
      return unmodelled(path);
    },
    // GitHub's implicit success() skips a job when any job it waits for, however indirectly, didn't
    // succeed: a skipped grandparent skips it even after its own need ran.
    needsSucceeded: [...ancestorsOf(workflow, name)].every((job) => results.get(job) === "success"),
    ancestorFailed: [...ancestorsOf(workflow, name)].some((job) => results.get(job) === "failure"),
    cancelled,
  };
}

/**
 * A called workflow's `inputs` for a call that passes `given`: each workflow_call input the call
 * names or its default, and null for an input only a run by hand has. An undeclared input fails.
 */
function callInputs(workflow: Workflow, given: Record<string, Value>) {
  const called = workflow.on.workflow_call?.inputs ?? {};
  const byHand = workflow.on.workflow_dispatch?.inputs ?? {};
  return (name: string): Value => {
    const input = called[name];
    if (input) {
      if (name in given) return given[name]!;
      if ("default" in input) return input.default as Value;
      // GitHub's own defaults for an omitted input without one.
      return input.type === "boolean" ? false : input.type === "number" ? 0 : "";
    }
    if (name in byHand) return null;
    return unmodelled(`inputs.${name}`);
  };
}

/**
 * The jobs of a called workflow that run for one call, in an order that respects their needs: a
 * job that runs succeeds unless `outcomes` says otherwise, and reports its outputs as "true" on
 * success; one that doesn't run is skipped.
 */
function simulate(
  workflow: Workflow,
  given: Record<string, Value>,
  event: string,
  cancelled: boolean,
  outcomes: Readonly<Record<string, Result>> = {},
) {
  const inputs = callInputs(workflow, given);
  const context = (path: string): Value => {
    if (path === "github.event_name") return event;
    if (path === "github.ref") return "refs/heads/main";
    if (path.startsWith("inputs.")) return inputs(path.slice("inputs.".length));
    // Every kill switch on: the worst case.
    if (path === "vars.MARKETING_DEPLOY_ENABLED" || path === "vars.STORE_AUTOMATION_ENABLED")
      return "true";
    return unmodelled(path);
  };
  const results = new Map<string, Result>();
  const outputs = (job: string, output: string): Value => {
    if (!(output in (workflow.jobs[job]!.outputs ?? {})))
      return unmodelled(`needs.${job}.outputs.${output}`);
    return results.get(job) === "success" ? "true" : "";
  };
  const pending = Object.keys(workflow.jobs);
  while (pending.length > 0) {
    const index = pending.findIndex((name) =>
      needsOf(workflow.jobs[name]!).every((need) => results.has(need)),
    );
    if (index === -1) throw new Error(`A cycle among ${pending.join(", ")}`);
    const [name] = pending.splice(index, 1);
    const scope = jobScope(workflow, name!, results, outputs, context, cancelled);
    results.set(
      name!,
      runs(workflow.jobs[name!]!.if, scope) ? (outcomes[name!] ?? "success") : "skipped",
    );
  }
  return [...results].flatMap(([name, result]) => (result === "success" ? [name] : []));
}

const release = read("release.yml");
const PUBLIC = ["publish", "discord", "feed", "store-gate", "store", "finalize", "website-refresh"];

/**
 * The publication jobs of one Release run. Every job's own condition decides whether it runs, in
 * workflow order; a job that runs succeeds unless `outcomes` says otherwise, and an outcome for a
 * non-publication job stands in for whatever its condition would decide.
 */
function publication(
  workflow: Workflow,
  options: {
    event?: string;
    dry?: string;
    channel?: string;
    operation?: string;
    cancelled?: boolean;
    outcomes?: Record<string, Result>;
    reused?: boolean;
  } = {},
) {
  const event = options.event ?? "schedule";
  const results = new Map<string, Result>();
  const actual = new Map<string, Result>();
  const plan = {
    skip: "false",
    "dry-run": options.dry ?? "false",
    channel: options.channel ?? "nightly",
    tag: "v0.0.22",
    promoted: options.channel === "stable" ? "v0.0.22-nightly.20261029.1" : "",
  };
  const outputs = (job: string, output: string): Value => {
    if (!(output in (workflow.jobs[job]?.outputs ?? {})))
      return unmodelled(`needs.${job}.outputs.${output}`);
    if (actual.get(job) !== "success") return "";
    if (job === "plan") return plan[output as keyof typeof plan] ?? unmodelled(output);
    if (job === "validation") return options.reused ? "true" : "false";
    return "true";
  };
  const context = (path: string): Value => {
    if (path === "github.event_name") return event;
    if (path === "github.ref") return "refs/heads/main";
    if (path === "github.repository" || path === "github.event.pull_request.head.repo.full_name")
      return "Mr-Streamer-OSS/MrStreamer";
    if (path === "github.event.label.name") return "release dry run";
    if (path === "inputs.dry-run") return options.dry === "true";
    if (path === "inputs.operation")
      return options.operation ?? (event === "workflow_dispatch" ? "release" : "");
    return unmodelled(path);
  };
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const forced = PUBLIC.includes(name) ? undefined : options.outcomes?.[name];
    const scope = jobScope(workflow, name, results, outputs, context, options.cancelled ?? false);
    const result =
      forced ?? (runs(job.if, scope) ? (options.outcomes?.[name] ?? "success") : "skipped");
    actual.set(name, result);
    const tolerated = job["continue-on-error"];
    const continuing =
      typeof tolerated === "boolean"
        ? tolerated
        : tolerated
          ? truthy(evaluate(tolerated.replace(/^\$\{\{(.*)\}\}$/s, "$1").trim(), scope))
          : false;
    results.set(name, result === "failure" && continuing ? "success" : result);
  }
  return PUBLIC.filter((name) => results.get(name) === "success");
}

describe("publication boundaries", () => {
  it("never publishes PRs or dry runs across ancestor outcomes and cancellation", () => {
    const ancestors = [
      ...new Set(PUBLIC.flatMap((name) => [...ancestorsOf(release, name)])),
    ].filter((name) => name !== "plan" && !PUBLIC.includes(name));
    const outcomes: Record<string, Result>[] = [
      {},
      ...ancestors.flatMap((name) => RESULTS.map((result) => ({ [name]: result }))),
      ...RESULTS.map((result) => Object.fromEntries(ancestors.map((name) => [name, result]))),
    ];
    for (const event of ["schedule", "workflow_dispatch", "pull_request"])
      for (const dry of ["true", "false"])
        for (const channel of ["stable", "nightly"])
          for (const reused of [true, false])
            for (const cancelled of [true, false])
              for (const outcome of outcomes)
                if (dry === "true" || event === "pull_request")
                  expect(
                    publication(release, {
                      event,
                      dry,
                      channel,
                      reused,
                      cancelled,
                      outcomes: outcome,
                    }),
                  ).toEqual([]);
  });
  it("publishes one nightly or the selected stable after all mandatory gates", () => {
    expect(publication(release)).toEqual(["publish", "discord", "feed"]);
    expect(publication(release, { channel: "stable" })).toEqual(PUBLIC);
    expect(publication(release, { channel: "stable", outcomes: { msix: "failure" } })).toEqual([
      "publish",
      "discord",
      "feed",
      "finalize",
      "website-refresh",
    ]);
    for (const job of [
      "check",
      "test",
      "bundle",
      "package",
      "package-windows",
      "sources",
      "validation",
    ])
      for (const result of ["failure", "cancelled"] as const)
        expect(publication(release, { outcomes: { [job]: result } }), job).toEqual([]);
    expect(publication(release, { channel: "stable", outcomes: { upgrade: "failure" } })).toEqual(
      [],
    );
    expect(publication(release, { cancelled: true })).toEqual([]);
  });
  it("accepts skipped fallback only with authenticated reuse", () => {
    expect(publication(release, { reused: true })).toEqual(["publish", "discord", "feed"]);
    expect(publication(release, { outcomes: { check: "skipped", test: "skipped" } })).toEqual([]);
  });
  it("keeps announcements and stable website handoff independent of feed and Store failures", () => {
    for (const feed of RESULTS)
      for (const store of RESULTS) {
        const jobs = publication(release, { channel: "stable", outcomes: { feed, store } });
        expect(jobs).toContain("discord");
        expect(jobs).toContain("website-refresh");
      }
    expect(
      publication(release, { channel: "stable", outcomes: { finalize: "failure" } }),
    ).not.toContain("website-refresh");
    expect(release.jobs["website-refresh"]).toMatchObject({
      uses: "./.github/workflows/website.yml",
      with: { deploy: true },
    });
  });
  it("runs maintenance on existing releases without publishing a release", () => {
    const event = "workflow_dispatch";
    expect(publication(release, { event, operation: "feed" })).toEqual(["feed"]);
    expect(publication(release, { event, operation: "store" })).toEqual(["store-gate", "store"]);
    expect(publication(release, { event, operation: "upgrade" })).toEqual([]);
  });
  it("recovery options cannot weaken normal release acceptance", () => {
    const selected = (job: string, key: string, operation: string) => {
      const expressions = release.jobs[job]!.steps?.flatMap((step) => step.env?.[key] ?? []) ?? [];
      if (!expressions.length) throw new Error(`Missing ${job}/${key}`);
      return expressions.map((expression) =>
        evaluate(expression.replace(/^\$\{\{(.*)\}\}$/s, "$1").trim(), {
          path: (path) =>
            (
              ({
                "inputs.operation": operation,
                "inputs.native_case": "compatibility",
                "inputs.allow-regress": true,
                "inputs.draft": "draft-id",
                "inputs.draft-metadata-sha256": "fingerprint",
              }) as Record<string, Value>
            )[path] ?? unmodelled(path),
          needsSucceeded: true,
          ancestorFailed: false,
          cancelled: false,
        }),
      );
    };
    expect(selected("upgrade", "NATIVE_CASE", "release")).toEqual(["all", "all"]);
    expect(selected("upgrade", "NATIVE_CASE", "upgrade")).toEqual([
      "compatibility",
      "compatibility",
    ]);
    expect(selected("feed", "ALLOW_REGRESS", "release")).toEqual([false]);
    expect(selected("feed", "ALLOW_REGRESS", "feed")).toEqual([true]);
    for (const key of ["DRAFT", "DRAFT_METADATA_SHA256"]) {
      expect(selected("store", key, "release")).toEqual([""]);
      expect(selected("store", key, "store")).not.toEqual([""]);
    }
  });
  it("maintenance dry runs publish nothing", () => {
    for (const operation of ["feed", "store", "upgrade"])
      expect(publication(release, { event: "workflow_dispatch", operation, dry: "true" })).toEqual(
        [],
      );
  });
  it("detects missing boundaries and failure-only publication leaks", () => {
    const original = release.jobs["publish"]!.if!;
    for (const condition of [
      "!cancelled()",
      "needs.plan.outputs.dry-run == 'false' && !cancelled()",
      "github.event_name != 'pull_request' && !cancelled()",
      `${original} || (failure() && needs.plan.outputs.dry-run == 'true')`,
      `${original} || (always() && needs.plan.outputs.channel == 'nightly' && needs.plan.outputs.dry-run == 'true')`,
    ]) {
      const copy = structuredClone(release);
      copy.jobs["publish"] = { ...copy.jobs["publish"]!, if: condition };
      expect(
        [
          publication(copy, { event: "pull_request", dry: "false" }),
          publication(copy, { event: "workflow_dispatch", dry: "true" }),
          publication(copy, {
            event: "workflow_dispatch",
            dry: "true",
            outcomes: { bundle: "failure" },
          }),
        ].some((jobs) => jobs.includes("publish")),
      ).toBe(true);
    }
  });
});

describe("the website", () => {
  const website = read("website.yml");

  it("publishes after a push to main or a run by hand, never for a pull request event", () => {
    expect(Object.keys(website.on)).toEqual(["workflow_call", "push", "workflow_dispatch"]);
    const published = ["website", "website-publish", "indexnow"];
    expect(simulate(website, {}, "push", false)).toEqual(published);
    expect(simulate(website, { deploy: true }, "workflow_dispatch", false)).toEqual(published);
    expect(simulate(website, {}, "push", true)).toEqual([]);
    expect(simulate(website, { deploy: true }, "pull_request", false)).toEqual([]);
  });

  // Runs the build job's real inputs and decision steps on a scratch repository, one push each.
  it("publishes a push only when it changes what the website is built from", () => {
    const steps = website.jobs["website"]!.steps!;
    const script = (id: string) => steps.find((step) => step.id === id)!.run!;
    const dir = mkdtempSync(join(tmpdir(), "website-delivery-"));
    const output = join(dir, "output");
    const gitEnv = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_NOSYSTEM: "1",
    };
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ],
        { cwd: dir, env: gitEnv, encoding: "utf8" },
      ).trim();
    try {
      git("init", "-q");
      mkdirSync(join(dir, ".github/workflows"), { recursive: true });
      writeFileSync(
        join(dir, ".github/workflows/website.yml"),
        readFileSync(".github/workflows/website.yml"),
      );
      git("add", ".");
      git("commit", "-qm", "base");
      const base = git("rev-parse", "HEAD");
      execFileSync("bash", ["-e", "-c", script("inputs")], {
        cwd: dir,
        env: { ...gitEnv, GITHUB_OUTPUT: output },
      });
      const inputs = readFileSync(output, "utf8")
        .trim()
        .replace(/^paths=/, "");
      const decide = (before: string, after: string, event = "push", requested = "") => {
        writeFileSync(output, "");
        const run = spawnSync("bash", ["-e", "-c", script("delivery")], {
          cwd: dir,
          env: {
            ...gitEnv,
            GITHUB_OUTPUT: output,
            EVENT: event,
            REQUESTED: requested,
            BEFORE: before,
            AFTER: after,
            INPUTS: inputs,
          },
        });
        return { status: run.status, output: readFileSync(output, "utf8") };
      };
      for (const [path, deploy] of [
        [".github/workflows/release.yml", false],
        ["docs/maintainers/ci.md", false],
        ["apps/marketing/src/page.ts", true],
        ["apps/marketing/README.md", false],
        [".cursor/skills/verify-mrstreamer/features/website.md", false],
        ["pnpm-lock.yaml", true],
      ] as const) {
        git("reset", "-q", "--hard", base);
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), "changed");
        git("add", path);
        git("commit", "-qm", path);
        expect(decide(base, git("rev-parse", "HEAD")), path).toEqual({
          status: 0,
          output: `deploy=${deploy}\n`,
        });
      }
      expect(decide("missing", "HEAD")).toMatchObject({ status: 1, output: "" });
      for (const requested of ["true", "false", ""]) {
        expect(decide("", "", "workflow_dispatch", requested)).toEqual({
          status: 0,
          output: `deploy=${requested === "true"}\n`,
        });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
