import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// Nothing a pull request or a dry run starts may publish: no GitHub release, update feed, Store
// submission, version commit or website. release-plan.ts makes every pull request event a dry run
// (test/release.test.ts holds it to that); this holds the workflows to the rest. publish.yml is
// where every publication lives. No pull request event starts it, release.yml calls it only for a
// run its plan says isn't a dry run, and inside, every job of a release's call waits on the
// release job, which refuses a pull request event once more. actionlint checks the rest of the
// YAML; docs/maintainers/ci.md traces each path.

interface Job {
  readonly if?: string;
  readonly needs?: string | readonly string[];
  readonly uses?: string;
  readonly environment?: string | { readonly name: string };
}

interface Workflow {
  readonly on: Record<string, unknown>;
  readonly jobs: Record<string, Job>;
}

const read = (name: string): Workflow =>
  parse(readFileSync(`.github/workflows/${name}`, "utf8")) as Workflow;
const release = read("release.yml");
const publish = read("publish.yml");
const PUBLISH = "./.github/workflows/publish.yml";

/** The jobs `job` waits for, directly or through the jobs it waits for. */
function upstream(jobs: Record<string, Job>, job: string): Set<string> {
  const needs = jobs[job]?.needs ?? [];
  const direct = typeof needs === "string" ? [needs] : needs;
  return new Set(direct.flatMap((name) => [name, ...upstream(jobs, name)]));
}

/** The words of a job's condition on one line, as GitHub reads a folded scalar. */
const condition = (job: Job | undefined) => job?.if?.split(/\s+/).join(" ") ?? "";

describe("publishing", () => {
  it("never starts on a pull request event of its own", () => {
    expect(Object.keys(publish.on)).toEqual(["workflow_call", "push", "workflow_dispatch"]);
  });

  it("is called by the release workflow only for a run its plan says isn't a dry run", () => {
    const calls = Object.entries(release.jobs).filter(([, job]) => job.uses === PUBLISH);

    expect(calls.map(([name]) => name).toSorted()).toEqual(["nightly-first-publish", "publish"]);
    for (const [name, job] of calls) {
      expect(condition(job), name).toContain("needs.plan.outputs.dry-run == 'false'");
      expect(upstream(release.jobs, name)).toContain("plan");
    }
  });

  it("is called by no other workflow", () => {
    for (const name of ["checks.yml", "package.yml", "upgrade-check.yml"]) {
      expect(Object.values(read(name).jobs).map((job) => job.uses)).not.toContain(PUBLISH);
    }
  });

  it("starts a release's every publication from the release job, which refuses a pull request", () => {
    expect(condition(publish.jobs["release"])).toBe(
      "inputs.tag != '' && github.event_name != 'pull_request'",
    );
    // Each of these runs in a release's call only once the release job succeeded: by its own
    // need, or behind the version commit, which needs it.
    for (const name of ["feed", "store-gate", "store", "finalize", "website", "website-publish"]) {
      expect(upstream(publish.jobs, name), name).toContain("release");
    }
  });

  it("names the Store's and the website's environments in no other workflow", () => {
    for (const name of ["release.yml", "checks.yml", "package.yml", "upgrade-check.yml"]) {
      for (const job of Object.values(read(name).jobs)) expect(job.environment).toBeUndefined();
    }
  });
});
