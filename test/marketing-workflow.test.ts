import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// Publishing the website is the one place these workflows hold a credential, the Vercel token. A
// run can't be tried without publishing, so this reads the two workflows and checks who can start
// a publication, which job gets the token, and that what runs beside it is pinned.

/** The parts of a workflow file this test reads. */
interface Workflow {
  readonly on: Record<string, { readonly branches?: readonly string[] } | null>;
  readonly jobs: Record<string, Job>;
}

interface Job {
  readonly if?: string;
  readonly needs?: string;
  readonly environment?: { readonly name: string };
  readonly steps: readonly { readonly uses?: string; readonly run?: string }[];
}

const read = (name: string): { text: string; workflow: Workflow } => {
  const text = readFileSync(`.github/workflows/${name}`, "utf8");
  return { text, workflow: parse(text) as Workflow };
};
const build = read("marketing.yml");
const deploy = read("marketing-deploy.yml");
const { publish, ...others } = deploy.workflow.jobs;

describe("publishing the website", () => {
  it("starts only from main, and only once the owner turned it on", () => {
    expect(Object.keys(deploy.workflow.on)).toEqual(["push", "workflow_dispatch"]);
    expect(deploy.workflow.on["push"]?.branches).toEqual(["main"]);
    // A run started by hand from another branch builds nothing, so it publishes nothing.
    expect(others["build"]?.if).toBe("github.ref == 'refs/heads/main'");
    expect(publish?.needs).toBe("build");
    expect(publish?.if).toBe("vars.MARKETING_DEPLOY_ENABLED == 'true'");
  });

  it("gives the token to the publishing job alone, which runs nothing from the repository", () => {
    expect(build.text).not.toContain("secrets.");
    for (const job of Object.values(others)) {
      expect(JSON.stringify(job)).not.toContain("secrets.");
      expect(job.environment).toBeUndefined();
    }
    expect(publish?.environment?.name).toBe("marketing-production");
    const uses = publish?.steps.flatMap((step) => step.uses ?? []) ?? [];
    expect(uses.some((action) => action.startsWith("actions/checkout@"))).toBe(false);
  });

  it("pins every action to a commit and the Vercel CLI to a version", () => {
    const steps = [build, deploy].flatMap(({ workflow }) =>
      Object.values(workflow.jobs).flatMap((job) => job.steps),
    );
    for (const step of steps) {
      if (step.uses) expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
    }
    const published = steps.filter((step) => step.run?.includes("vercel"));
    expect(published.map((step) => /vercel@\S+/.exec(step.run ?? "")?.[0])).toEqual([
      "vercel@62.2.0",
    ]);
  });
});
