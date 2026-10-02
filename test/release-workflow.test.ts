import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// A stable run can build and publish two releases, a nightly of main first and then the stable
// release, through the same reusable workflows. Artifacts are named per run, so every artifact the
// two calls upload needs a name of its own: deploy-pages refuses a name it finds twice. A dry run
// can't deploy, so this reads the workflows and works out the names a run produces.

/** The parts of a workflow file this test reads. */
interface Workflow {
  readonly on: {
    readonly workflow_call?: { readonly inputs?: Record<string, { default?: unknown }> };
  };
  readonly jobs: Record<string, Job>;
}

interface Job {
  readonly if?: string;
  /** A reusable workflow the job calls, and what it passes. */
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
  readonly strategy?: { readonly matrix?: { readonly include?: Record<string, string>[] } };
  readonly steps?: readonly { readonly uses?: string; readonly with?: Record<string, unknown> }[];
}

/** Answers an expression's name, such as `inputs.version`. */
type Context = (name: string) => string;

/**
 * Substitutes `${{ ... }}` in `text`: names from `context`, quoted literals, and `a || 'b'`,
 * which takes the first non-empty value. Throws on anything else, so a new kind of expression in a
 * name makes the test say so instead of guessing.
 */
function evaluate(text: string, context: Context): string {
  return text.replace(/\$\{\{\s*(.+?)\s*\}\}/g, (_, expression: string) => {
    for (const part of expression.split("||").map((each) => each.trim())) {
      const value = /^'(.*)'$/.exec(part)?.[1] ?? context(part);
      if (value) return value;
    }
    return "";
  });
}

/** Names `values` answers, failing for any other. */
function known(values: Record<string, string>): Context {
  return (name) => {
    const value = values[name];
    if (value === undefined) throw new Error(`The test doesn't know ${name}.`);
    return value;
  };
}

/** The artifact names a run of `path` uploads, and the ones its deploy-pages steps take. */
function artifacts(path: string, context: Context): { uploaded: string[]; deployed: string[] } {
  const workflow: Workflow = parse(readFileSync(path, "utf8"));
  const defaults = workflow.on.workflow_call?.inputs ?? {};
  const uploaded: string[] = [];
  const deployed: string[] = [];
  for (const job of Object.values(workflow.jobs)) {
    // A release run is no pull request, so a job meant for one channel runs on that channel only.
    const channel = /inputs\.channel == '(\w+)'/.exec(job.if ?? "")?.[1];
    if (channel && channel !== context("inputs.channel")) continue;
    if (job.uses) {
      const called = artifacts(job.uses, (name) => {
        if (!name.startsWith("inputs.")) return context(name);
        const input = name.slice("inputs.".length);
        return evaluate(String(job.with?.[input] ?? defaults[input]?.default ?? ""), context);
      });
      uploaded.push(...called.uploaded);
      deployed.push(...called.deployed);
      continue;
    }
    for (const leg of job.strategy?.matrix?.include ?? [{}]) {
      const inLeg: Context = (name) =>
        name.startsWith("matrix.") ? (leg[name.slice("matrix.".length)] ?? "") : context(name);
      for (const step of job.steps ?? []) {
        const name = (key: string) => evaluate(String(step.with?.[key]), inLeg);
        if (/^actions\/upload(-pages)?-artifact@/.test(step.uses ?? ""))
          uploaded.push(name("name"));
        if (step.uses?.startsWith("actions/deploy-pages@")) deployed.push(name("artifact_name"));
      }
    }
  }
  return { uploaded, deployed };
}

describe("a stable run that publishes a nightly first", () => {
  /** The plan of a stable 0.0.4 run whose nightly first is 0.0.4-nightly.20261002.117. */
  const run = (attempt: number) =>
    artifacts(
      ".github/workflows/release.yml",
      known({
        "github.run_attempt": String(attempt),
        "needs.plan.outputs.channel": "stable",
        "needs.plan.outputs.version": "0.0.4",
        "needs.plan.outputs.tag": "v0.0.4",
        "needs.plan.outputs.sha": "tested-commit",
        "needs.plan.outputs.previous-tag": "v0.0.3",
        "needs.plan.outputs.first-version": "0.0.4-nightly.20261002.117",
        "needs.plan.outputs.first-tag": "v0.0.4-nightly.20261002.117",
        "needs.plan.outputs.first-sha": "main-commit",
        "needs.plan.outputs.first-previous-tag": "v0.0.4-nightly.20261002.110",
      }),
    );

  it("names every artifact it uploads apart", () => {
    const { uploaded } = run(1);

    expect(uploaded).toContain("release-mac-arm64-0.0.4-nightly.20261002.117");
    expect(uploaded).toContain("release-mac-arm64-0.0.4");
    expect(uploaded.filter((name, index) => uploaded.indexOf(name) !== index)).toEqual([]);
  });

  it("deploys each release's feed from its own Pages artifact, again in a later attempt", () => {
    const first = run(1);

    expect(first.deployed).toEqual([
      "github-pages-0.0.4-nightly.20261002.117-1",
      "github-pages-0.0.4-1",
    ]);
    expect(first.uploaded).toEqual(expect.arrayContaining(first.deployed));
    // Artifacts of earlier attempts stay in the run, so a re-run deploys from new names.
    expect(run(2).deployed.filter((name) => first.uploaded.includes(name))).toEqual([]);
  });
});
