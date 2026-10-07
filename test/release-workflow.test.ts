import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { artifactName, STORE_ENVIRONMENT, STORE_NAME } from "../scripts/store-release.ts";

// A stable run can build and publish two releases, a nightly of main first and then the stable
// release, through the same reusable workflows. Artifacts are named per run, so every artifact the
// two calls upload needs a name of its own: deploy-pages refuses a name it finds twice. A dry run
// can't deploy, so this reads the workflows and works out the names a run produces.
//
// A stable run also sends its package to the Microsoft Store, with the one credential these
// workflows hold for it. No run can be tried without a real submission, so this also reads which
// runs reach that job, what it is given, and what runs beside the credential.
//
// A stable release builds a commit an earlier nightly tested, under main's workflow, so the Store
// package's check works out the version with source that can be older than the check. That command
// runs here for real, on this checkout.

/** The parts of a workflow file this test reads. */
interface Workflow {
  readonly on: {
    readonly workflow_call?: { readonly inputs?: Record<string, { default?: unknown }> };
  };
  readonly jobs: Record<string, Job>;
}

interface Job {
  readonly if?: string;
  readonly needs?: string | readonly string[];
  /** A reusable workflow the job calls, and what it passes. */
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
  readonly secrets?: string;
  readonly permissions?: Record<string, string>;
  readonly environment?: { readonly name: string };
  readonly concurrency?: Record<string, unknown>;
  readonly defaults?: { readonly run?: { readonly "working-directory"?: string } };
  readonly strategy?: { readonly matrix?: { readonly include?: Record<string, string>[] } };
  readonly steps?: readonly Step[];
}

interface Step {
  readonly id?: string;
  readonly if?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Record<string, unknown>;
  readonly env?: Record<string, string>;
}

const WORKFLOWS = ".github/workflows";
const read = (name: string): Workflow => parse(readFileSync(`${WORKFLOWS}/${name}`, "utf8"));

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
    // Only the stable release builds a Store package.
    expect(uploaded.filter((name) => name.startsWith("msix-"))).toEqual([
      "msix-0.0.4",
      "msix-failed-0.0.4",
    ]);
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

describe("checking the Store package of a stable release", () => {
  const job = read("build-release.yml").jobs["msix"];
  const check = job?.steps?.find((step) => step.id === "check")?.run ?? "";
  const script = /\bnode --input-type=module -e '([^']+)' \$env:VERSION$/m.exec(check)?.[1] ?? "";

  it("works out the version with the script every tested nightly has", () => {
    // As the step runs it: in the job's folder, the release version its one argument.
    const version = execFileSync(process.execPath, ["--input-type=module", "-e", script, "0.0.4"], {
      cwd: job?.defaults?.run?.["working-directory"],
      encoding: "utf8",
    });

    // Nightlies from before packages/contracts/src/package-version.ts have it only in this script.
    expect(script).toContain('from "./scripts/msix-version.ts"');
    expect(version.trim()).toBe("1.0.4.0");
  });

  it("insists on the name the Store's listings take", () => {
    expect(check).toContain(`"${STORE_NAME}"`);
  });
});

describe("sending a stable release to the Microsoft Store", () => {
  const release = read("release.yml");
  const build = read("build-release.yml");
  const store = read("microsoft-store.yml");
  const { gate, store: submit, ...others } = store.jobs;
  const steps = submit?.steps ?? [];
  const called = "./.github/workflows/microsoft-store.yml";

  it("happens only for a published stable release started by hand from main, whose package passed", () => {
    const job = build.jobs["store"];

    expect(job?.uses).toBe(called);
    expect(job?.needs).toEqual(["publish", "msix"]);
    expect(job?.if?.split(/\s+/).join(" ")).toBe(
      "inputs.channel == 'stable' && github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'",
    );
    // No push, tag, release, schedule or pull request starts the Store workflow itself.
    expect(Object.keys(store.on)).toEqual(["workflow_call", "workflow_dispatch"]);
    // And nothing else calls it or names its environment.
    for (const file of readdirSync(WORKFLOWS)) {
      const jobs = Object.entries(read(file).jobs);
      const calling = jobs.filter(([, each]) => each.uses === called).map(([name]) => name);
      expect(calling).toEqual(file === "build-release.yml" ? ["store"] : []);
      const named = jobs.filter(([, each]) => each.environment?.name === STORE_ENVIRONMENT);
      expect(named.map(([name]) => name)).toEqual(file === "microsoft-store.yml" ? ["store"] : []);
    }
  });

  it("takes the package under the name the build job gives one that passed its checks", () => {
    const version = known({ "inputs.version": "0.0.4" });
    const uploads = (build.jobs["msix"]?.steps ?? []).filter((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    const download = steps.find((step) => step.uses?.startsWith("actions/download-artifact@"));

    // The upload without a condition runs only when every step before it succeeded.
    expect(
      uploads.map((step) => [step.if, evaluate(String(step.with?.["name"]), version)]),
    ).toEqual([
      [undefined, artifactName("0.0.4")],
      ["failure()", "msix-failed-0.0.4"],
    ]);
    expect(evaluate(String(download?.with?.["name"]), version)).toBe(artifactName("0.0.4"));
    expect(build.jobs["store"]?.with).toEqual({
      version: "${{ inputs.version }}",
      sha: "${{ inputs.sha }}",
      sha256: "${{ needs.msix.outputs.sha256 }}",
    });
  });

  it("names the environment only once the setup is checked, and queues behind any other Store job", () => {
    expect(others).toEqual({});
    expect(gate?.environment).toBeUndefined();
    expect(JSON.stringify(gate)).not.toContain("secrets.");
    expect(submit?.needs).toBe("gate");
    expect(submit?.if).toBe("needs.gate.outputs.ready == 'true'");
    expect(submit?.concurrency).toEqual({
      group: "microsoft-store",
      "cancel-in-progress": false,
      queue: "max",
    });
  });

  it("gives the credential to the last step of a job that runs main's scripts and installs nothing", () => {
    const holding = steps.filter((step) => JSON.stringify(step).includes("secrets."));

    expect(holding).toEqual([steps.at(-1)]);
    expect(holding[0]?.env?.["STORE_CLIENT_SECRET"]).toBe("${{ secrets.STORE_CLIENT_SECRET }}");
    for (const step of [...(gate?.steps ?? []), ...steps]) {
      // Pinned actions, none of which installs packages, and a checkout of the run's own commit.
      if (step.uses) expect(step.uses).toMatch(/^actions\/[\w-]+@[0-9a-f]{40}$/);
      if (step.uses?.startsWith("actions/checkout@")) expect(step.with).toBeUndefined();
      const commands = (step.run ?? "").split("\n").filter((line) => !/^(args[=+]|\[ )/.test(line));
      for (const command of commands.filter(Boolean)) {
        expect(command).toMatch(/^node scripts\/store-(release|submission)\.ts /);
      }
    }
  });

  it("is granted, by every workflow that calls it, the permissions its jobs ask for", () => {
    const asked = [gate, submit].flatMap((job) => Object.entries(job?.permissions ?? {}));
    const callers = [build.jobs["store"], release.jobs["release"], release.jobs["nightly-first"]];

    expect(asked).toContainEqual(["actions", "read"]);
    for (const caller of callers) {
      for (const [scope, level] of asked) {
        expect([level, "write"]).toContain(caller?.permissions?.[scope]);
      }
    }
    // The called job's credential is the environment's, which reaches it only this way.
    expect(build.jobs["store"]?.secrets).toBe("inherit");
  });

  it("reads only settings the setup wizard stores and the runbook explains", () => {
    const text = readFileSync(`${WORKFLOWS}/microsoft-store.yml`, "utf8");
    const settings = [
      ...new Set([...text.matchAll(/\b(?:vars|secrets)\.(\w+)/g)].map(([, name]) => name)),
    ];
    const wizard = readFileSync("scripts/setup-microsoft-store.sh", "utf8");
    const runbook = readFileSync("docs/maintainers/microsoft-store.md", "utf8");

    expect(settings.toSorted()).toEqual([
      "STORE_AUTOMATION_ENABLED",
      "STORE_CLIENT_ID",
      "STORE_CLIENT_SECRET",
      "STORE_CLIENT_SECRET_EXPIRES",
      "STORE_TENANT_ID",
    ]);
    for (const setting of settings) {
      expect(wizard).toContain(setting);
      expect(runbook).toContain(`\`${setting}\``);
    }
  });
});

// A release owes the sources of what its installers carry, and a pull request's dry run is the
// only run that can show a source went missing before a release needs it.
describe("the source archives of a release", () => {
  const { jobs } = read("build-release.yml");
  const { sources, publish } = jobs;
  const version = known({ "inputs.version": "0.0.7" });

  /** Whether a job runs in every run: it and the jobs it waits for have no condition. */
  const unconditional = (name: string): boolean => {
    const job = jobs[name];
    return job !== undefined && !job.if && [job.needs ?? []].flat().every(unconditional);
  };

  it("are prepared in a dry run too, which publishes nothing", () => {
    expect(unconditional("sources")).toBe(true);
    expect(publish?.if).toBe("github.event_name != 'pull_request'");
  });

  it("reach the release with the installers, which never publishes without them", () => {
    const upload = sources?.steps?.find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    const download = publish?.steps?.find((step) =>
      step.uses?.startsWith("actions/download-artifact@"),
    );
    const uploaded = evaluate(String(upload?.with?.["name"]), version);
    const taken = evaluate(String(download?.with?.["pattern"]), version);

    expect(publish?.needs).toContain("sources");
    expect(uploaded).toBe("release-sources-0.0.7");
    expect(uploaded).toMatch(new RegExp(`^${taken.replace("*", ".*")}$`));
  });
});
