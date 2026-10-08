import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// Publishing the website is the one place these workflows hold a credential, the Vercel token. A
// run can't be tried without publishing, so this reads the two workflows and checks who can start
// a publication, which job gets the token, and that what runs beside it is pinned. The step that
// keeps an overtaken build from being published runs here for real, against repositories made
// for it.

/** The parts of a workflow file this test reads. */
interface Workflow {
  readonly on: {
    readonly push?: { readonly branches?: readonly string[]; readonly paths?: readonly string[] };
    readonly workflow_run?: {
      readonly workflows: readonly string[];
      readonly types: readonly string[];
      readonly branches: readonly string[];
    };
  };
  readonly concurrency?: { readonly group: string; readonly "cancel-in-progress": boolean };
  readonly env?: Record<string, string>;
  readonly jobs: Record<string, Job>;
}

interface Job {
  readonly if?: string;
  readonly needs?: string;
  readonly environment?: { readonly name: string };
  readonly steps: readonly {
    readonly id?: string;
    readonly uses?: string;
    readonly run?: string;
  }[];
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
    expect(Object.keys(deploy.workflow.on)).toEqual(["push", "workflow_dispatch", "workflow_run"]);
    expect(deploy.workflow.on.push?.branches).toEqual(["main"]);
    expect(deploy.workflow.on.workflow_run).toEqual({
      workflows: ["Release"],
      types: ["completed"],
      branches: ["main"],
    });
    // A run started by hand from another branch builds nothing, so it publishes nothing.
    expect(others["build"]?.needs).toBe("trigger");
    expect(others["build"]?.if).toBe(
      "github.ref == 'refs/heads/main' && needs.trigger.outputs.allowed == 'true'",
    );
    expect(publish?.needs).toBe("build");
    expect(publish?.if).toBe("vars.MARKETING_DEPLOY_ENABLED == 'true'");
  });

  it("queues runs by branch, so one from another branch never replaces a waiting one from main", () => {
    expect(deploy.workflow.concurrency).toEqual({
      group: "marketing-production-${{ github.ref }}",
      "cancel-in-progress": false,
      queue: "max",
    });
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

/** The files a push must change to start a publication, one for each path the workflow lists. */
const websiteFiles = (deploy.workflow.on.push?.paths ?? []).map((path) =>
  path.replace("**", "page.html"),
);
/**
 * More files than GitHub's own comparison of two commits names, 300, and ahead of every website
 * file in the order it lists them, by path.
 */
const otherFiles = Array.from({ length: 301 }, (_, index) => `.a/file-${index}.txt`);

/**
 * What the publish job decides about a build once main has moved on: true when it leaves
 * publishing to a newer run. main holds the built commit, then a commit that changes `later`.
 * `built` names another commit as the build's. Throws when the step fails, which publishes
 * nothing either.
 */
function leftToNewerRun(later: readonly string[], built?: string): boolean {
  const folder = mkdtempSync(join(tmpdir(), "mr-streamer-marketing-"));
  // Git as the workflow's runner has it: no settings of whoever runs the tests.
  const env = {
    PATH: process.env["PATH"],
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.test",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.test",
  };
  const origin = join(folder, "origin.git");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: origin, env, encoding: "utf8" }).trim();
  const commit = (files: readonly string[], contents: string) => {
    for (const file of files) {
      mkdirSync(dirname(join(origin, file)), { recursive: true });
      writeFileSync(join(origin, file), contents);
    }
    git("add", "--all");
    git("commit", "--quiet", "--allow-empty", "--message", contents);
  };
  try {
    mkdirSync(origin);
    git("init", "--quiet", "--initial-branch=main");
    commit([...websiteFiles, ...otherFiles], "built");
    const head = git("rev-parse", "HEAD");
    commit(later, "later");
    const output = join(folder, "output");
    writeFileSync(output, "");
    const step = publish?.steps.find((each) => each.id === "newest");
    // As a runner starts a step's script.
    execFileSync(
      "bash",
      ["--noprofile", "--norc", "-eo", "pipefail", "-c", step?.run ?? "exit 1"],
      {
        env: {
          ...env,
          ...deploy.workflow.env,
          BUILT: built ?? head,
          GITHUB_SERVER_URL: `file://${folder}`,
          GITHUB_REPOSITORY: "origin",
          GITHUB_OUTPUT: output,
          RUNNER_TEMP: folder,
        },
        stdio: "pipe",
      },
    );
    return readFileSync(output, "utf8").includes("superseded=true");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

// The step is a bash script, as the workflow's Linux runner runs it.
describe.skipIf(process.platform === "win32")("a build that main has moved past", () => {
  it("is published when main changed nothing of the website, however many files it changed", () => {
    expect(leftToNewerRun([])).toBe(false);
    expect(leftToNewerRun(otherFiles)).toBe(false);
  });

  it.each(websiteFiles)("is left to a newer run when %s changed among 301 other files", (file) => {
    expect(leftToNewerRun([...otherFiles, file])).toBe(true);
  });

  it("is not published when its commit is no longer part of main", () => {
    expect(() => leftToNewerRun([], "0".repeat(40))).toThrow();
  });
});
