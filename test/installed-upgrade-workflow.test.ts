import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// The Windows installed upgrade check installs builds on a runner and reads releases and runs. It
// must stay a check: started by hand from main, able to read and nothing more, with GitHub's token
// in the one step that reads GitHub and no secret anywhere.

interface Step {
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly env?: Record<string, string>;
  readonly with?: Record<string, unknown>;
}

const text = readFileSync(".github/workflows/windows-installed-upgrade.yml", "utf8");
const workflow = parse(text) as {
  readonly on: Record<string, unknown>;
  readonly permissions: Record<string, string>;
  readonly jobs: Record<
    string,
    { readonly if?: string; readonly permissions?: unknown; readonly steps: readonly Step[] }
  >;
};
const jobs = Object.values(workflow.jobs);

describe("the Windows installed upgrade check", () => {
  it("starts only by hand, from main of this repository", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    for (const job of jobs) {
      expect(job.if).toContain("github.repository == 'Mr-Streamer-OSS/MrStreamer'");
      expect(job.if).toContain(
        "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)",
      );
    }
  });

  it("can read releases, runs and pull requests, and change nothing", () => {
    expect(workflow.permissions).toEqual({
      contents: "read",
      actions: "read",
      "pull-requests": "read",
    });
    for (const job of jobs) expect(job.permissions).toBeUndefined();
  });

  it("holds no secret, and gives the token to the step that reads GitHub alone", () => {
    expect(text).not.toMatch(/secrets\./);
    const holders = jobs
      .flatMap((job) => job.steps)
      .filter((step) => JSON.stringify(step).includes("github.token"));
    expect(holders.map((step) => step.name)).toEqual(["Find and check the three installers"]);
    expect(holders[0]?.run).toMatch(/installed-upgrade\.ts resolve /);
    const checkout = jobs
      .flatMap((job) => job.steps)
      .find((step) => /checkout@/.test(step.uses ?? ""));
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });
});
