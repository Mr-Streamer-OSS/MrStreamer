// Plans releases for the release workflow: the commit a run builds, its version and tag, and
// whether a scheduled nightly is due. docs/maintainers/releasing.md describes the policy.
//
//   node scripts/release-plan.ts nightly --ref <ref> --sha <commit> --run <number> [--scheduled | --dry-run]
//   node scripts/release-plan.ts stable --ref <ref> [--version 0.1.0]
//   node scripts/release-plan.ts check --version <version>   right before publishing
//   node scripts/release-plan.ts notes --tag <tag> --sha <commit> [--previous-tag <tag>]
//   node scripts/release-plan.ts record --version <version>  after a stable release, on main
//
// Versions: package.json on main holds the newest stable release (0.0.0 before the first).
// Nightlies preview the next patch, 0.0.2-nightly.20261002.14, counting from package.json or the
// newest stable release, whichever is newer, so a stable release that main has not recorded yet
// never makes later nightlies sort below it. A stable release rebuilds the commit of the latest
// published nightly, as the version that nightly previewed unless another is given.
//
// Reads GitHub with gh, prints the plan as GitHub Actions outputs, and fails with the reason when
// a release is refused. Release jobs run it with plain node before installing packages, so it
// imports only node: modules and dependency-free files from src/shared.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  channelOf,
  compareVersions,
  formatVersion,
  parseVersion,
  type Channel,
  type Version,
} from "../src/shared/version.ts";

/** A scheduled nightly waits at least this long after the previous one. */
export const NIGHTLY_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface Release {
  readonly tag: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  /** ISO time; null while a draft. */
  readonly publishedAt: string | null;
}

const HISTORIES = ["ahead", "behind", "identical", "diverged"] as const;

/** How a head commit relates to a base, as GitHub's compare API reports it. */
export type History = (typeof HISTORIES)[number];

/** A pull request merged into the default branch. */
export interface PullRequest {
  readonly number: number;
  readonly title: string;
  /** The author's login. */
  readonly author: string;
  readonly url: string;
}

/** What a plan reads from GitHub. The command line answers through gh, tests from fixtures. */
export interface Repository {
  /** The repository's page, such as https://github.com/owner/repo. */
  readonly url: string;
  readonly defaultBranch: string;
  /** Every release, drafts included. */
  readonly releases: readonly Release[];
  /** Every tag, with or without a release. */
  readonly tags: readonly string[];
  /** How `head` relates to `base`: "ahead" when head contains base and more. */
  compare(base: string, head: string): Promise<History>;
  /** The commit a tag points at, through annotated tags. */
  commitOf(tag: string): Promise<string>;
  /**
   * The commits `head` has and `base` doesn't, oldest first. With no `base`, every commit up to
   * and including `head`.
   */
  commits(base: string | null, head: string): Promise<readonly string[]>;
  /** The pull requests merged into the default branch that brought `commit` in. */
  pullRequestsOf(commit: string): Promise<readonly PullRequest[]>;
}

export interface Plan {
  readonly channel: Channel;
  readonly version: string;
  readonly tag: string;
  /** The commit every job of the run checks out. */
  readonly sha: string;
  /**
   * Notes list the changes since this release of the same channel: the previous stable release
   * for a stable one, the previous nightly for a nightly. Null for a channel's first release.
   */
  readonly previousTag: string | null;
}

export interface Skip {
  readonly skip: string;
  /** Set when skipping needs a maintainer's attention. */
  readonly warning: boolean;
}

export interface NightlyRequest {
  /** The ref the run was started from. */
  readonly ref: string;
  readonly sha: string;
  /** The workflow run number, unique per workflow. */
  readonly run: number;
  readonly now: number;
  /** The version in package.json at `sha`. */
  readonly recorded: string;
  /** Scheduled runs build only when a nightly is due. */
  readonly scheduled: boolean;
  /** Dry runs build any branch and publish nothing. */
  readonly dryRun: boolean;
}

export interface StableRequest {
  readonly ref: string;
  /** Replaces the version the nightly previewed; the commit stays the nightly's. */
  readonly version?: string | undefined;
}

export async function planNightly(repo: Repository, request: NightlyRequest): Promise<Plan | Skip> {
  if (!request.dryRun) assertDefaultBranch(repo, request.ref, "nightly");
  if (request.scheduled) {
    const skip = await nightlySkip(repo, request.sha, request.now);
    if (skip) return skip;
  }
  const known = releasedVersions(repo);
  const recorded = parseVersion(request.recorded);
  if (!recorded || recorded.nightly) {
    throw new Error(
      `package.json holds "${request.recorded}", not a stable version such as 0.1.0.`,
    );
  }
  const base = [recorded, ...known.filter((version) => !version.nightly)]
    .sort(compareVersions)
    .at(-1)!;
  const version: Version = {
    ...base,
    patch: base.patch + 1,
    nightly: { date: utcDate(request.now), run: request.run },
  };
  assertUnreleased(known, version);
  return {
    channel: "nightly",
    version: formatVersion(version),
    tag: tagOf(version),
    sha: request.sha,
    previousTag: latestNightly(repo.releases)?.tag ?? null,
  };
}

export async function planStable(repo: Repository, request: StableRequest): Promise<Plan> {
  assertDefaultBranch(repo, request.ref, "stable");
  const nightly = latestNightly(repo.releases);
  if (!nightly) {
    throw new Error("No published nightly. A stable release promotes the latest nightly.");
  }
  const previewed = parseVersion(nightly.tag)!;
  const sha = await repo.commitOf(nightly.tag);
  const history = await repo.compare(sha, repo.defaultBranch);
  if (history !== "ahead" && history !== "identical") {
    throw new Error(
      `${nightly.tag} was built from ${sha}, which ${repo.defaultBranch} does not contain (${history}).`,
    );
  }

  const version = request.version ? parseVersion(request.version) : { ...previewed, nightly: null };
  if (!version || version.nightly) {
    throw new Error(`"${request.version}" is not a stable version such as 0.1.0.`);
  }
  if (compareVersions(version, previewed) <= 0) {
    throw new Error(
      `${formatVersion(version)} would sort before ${nightly.tag}, the nightly it promotes, so nightly users would never be offered it.`,
    );
  }
  assertUnreleased(releasedVersions(repo), version);
  const previousStable = repo.releases
    .filter((release) => !release.draft && !release.prerelease)
    .flatMap((release) => {
      const parsed = parseVersion(release.tag);
      return parsed && !parsed.nightly ? [parsed] : [];
    })
    .sort(compareVersions)
    .at(-1);
  return {
    channel: "stable",
    version: formatVersion(version),
    tag: tagOf(version),
    sha,
    previousTag: previousStable ? tagOf(previousStable) : null,
  };
}

/**
 * Throws unless `version` is still unused and sorts after every release it competes with: a
 * stable release after every stable release, a nightly after every release. Runs again right
 * before publishing, as the other queue may have published in the meantime. Drafts don't count:
 * users never see them and they have no tag.
 */
export function checkUnreleased(repo: Repository, version: string): void {
  const parsed = parseVersion(version);
  if (!parsed) throw new Error(`"${version}" is not a release version.`);
  assertUnreleased(releasedVersions(repo), parsed);
}

/**
 * The notes of a release: every pull request merged from the previous release of its channel up
 * to the commit it builds, once each, oldest first. A channel's first release lists everything up
 * to its commit. Pull requests merged after that commit are left out, even once main has them.
 */
export async function releaseNotes(
  repo: Repository,
  plan: Pick<Plan, "tag" | "sha" | "previousTag">,
): Promise<string> {
  const commits = await repo.commits(plan.previousTag, plan.sha);
  const pulls = (await Promise.all(commits.map((commit) => repo.pullRequestsOf(commit)))).flat();
  const listed = new Map(pulls.map((pull) => [pull.number, pull]));
  const changes = [...listed.values()].map(
    (pull) => `* ${pull.title} by @${pull.author} in ${pull.url}`,
  );
  const changelog = plan.previousTag
    ? `${repo.url}/compare/${plan.previousTag}...${plan.tag}`
    : `${repo.url}/commits/${plan.tag}`;
  return [
    ...(changes.length > 0 ? ["## What's Changed", ...changes, ""] : []),
    `**Full Changelog**: ${changelog}`,
  ].join("\n");
}

/** The version main records after `released` is published, or null when it already has it or a newer one. */
export function recordedVersion(current: string, released: string): string | null {
  const now = parseVersion(current);
  const next = parseVersion(released);
  if (!next || next.nightly) throw new Error(`"${released}" is not a stable version.`);
  return now && compareVersions(now, next) >= 0 ? null : formatVersion(next);
}

/** The newest published nightly. Drafts and pre-releases without a nightly version don't count. */
function latestNightly(releases: readonly Release[]): Release | undefined {
  return releases
    .filter(
      (release) =>
        !release.draft &&
        release.prerelease &&
        release.publishedAt !== null &&
        parseVersion(release.tag)?.nightly,
    )
    .sort((a, b) => Date.parse(b.publishedAt!) - Date.parse(a.publishedAt!))[0];
}

/** Why a scheduled nightly should not build `sha` now, or null when it should. */
async function nightlySkip(repo: Repository, sha: string, now: number): Promise<Skip | null> {
  const last = latestNightly(repo.releases);
  if (!last) return null;
  if (now - Date.parse(last.publishedAt!) < NIGHTLY_INTERVAL_MS) {
    return { skip: `${last.tag} was published less than six hours ago.`, warning: false };
  }
  switch (await repo.compare(last.tag, sha)) {
    case "ahead":
      return null;
    case "identical":
      return { skip: `Nothing new since ${last.tag}.`, warning: false };
    case "behind":
      return { skip: `${sha} is older than ${last.tag}.`, warning: false };
    case "diverged":
      return {
        skip: `${repo.defaultBranch} no longer contains ${last.tag}. Start a nightly by hand to continue from ${repo.defaultBranch}.`,
        warning: true,
      };
  }
}

function assertDefaultBranch(repo: Repository, ref: string, channel: Channel): void {
  if (ref !== `refs/heads/${repo.defaultBranch}`) {
    throw new Error(
      `Start ${channel} releases from ${repo.defaultBranch}, not ${ref}. Label a pull request "release dry run" to try a branch.`,
    );
  }
}

/** Versions of every tag and published release. */
function releasedVersions(repo: Repository): Version[] {
  const published = repo.releases.filter((release) => !release.draft).map((release) => release.tag);
  return [...new Set([...repo.tags, ...published])].flatMap((tag) => {
    const parsed = parseVersion(tag);
    return parsed ? [parsed] : [];
  });
}

function assertUnreleased(known: readonly Version[], version: Version): void {
  if (known.some((other) => compareVersions(other, version) === 0)) {
    throw new Error(`${tagOf(version)} already exists.`);
  }
  const rivals = version.nightly ? known : known.filter((other) => channelOf(other) === "stable");
  const newest = rivals.toSorted(compareVersions).at(-1);
  if (newest && compareVersions(version, newest) < 0) {
    throw new Error(
      `${formatVersion(version)} would sort before ${formatVersion(newest)}, which is already released.`,
    );
  }
}

function tagOf(version: Version): string {
  return `v${formatVersion(version)}`;
}

function utcDate(time: number): number {
  return Number(new Date(time).toISOString().slice(0, 10).replaceAll("-", ""));
}

/** The repository the workflow runs in, read through gh. */
function githubRepository(): Repository {
  const name = process.env["GITHUB_REPOSITORY"] ?? "{owner}/{repo}";
  const api = (path: string, jq: string, paginate = false) =>
    execFileSync(
      "gh",
      ["api", ...(paginate ? ["--paginate"] : []), `repos/${name}${path}`, "--jq", jq],
      { encoding: "utf8" },
    ).trim();
  const lines = (text: string) => text.split("\n").filter(Boolean);

  const releases = lines(
    api(
      "/releases?per_page=100",
      '.[] | [.tag_name, .draft, .prerelease, .published_at // ""] | @tsv',
      true,
    ),
  ).map((line): Release => {
    const [tag = "", draft, prerelease, publishedAt] = line.split("\t");
    return {
      tag,
      draft: draft === "true",
      prerelease: prerelease === "true",
      publishedAt: publishedAt || null,
    };
  });
  const [defaultBranch = "", url = ""] = api("", "[.default_branch, .html_url] | @tsv").split("\t");
  return {
    url,
    defaultBranch,
    releases,
    tags: lines(api("/tags?per_page=100", ".[].name", true)),
    async compare(base, head) {
      const status = api(
        `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=1`,
        ".status",
      );
      const history = HISTORIES.find((known) => known === status);
      if (!history) throw new Error(`GitHub compared ${base} and ${head} as "${status}".`);
      return history;
    },
    async commitOf(tag) {
      return api(`/commits/${encodeURIComponent(tag)}`, ".sha");
    },
    async commits(base, head) {
      if (base === null) {
        return lines(
          api(`/commits?sha=${encodeURIComponent(head)}&per_page=100`, ".[].sha", true),
        ).reverse();
      }
      return lines(
        api(
          `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=100`,
          ".commits[].sha",
          true,
        ),
      );
    },
    async pullRequestsOf(commit) {
      const merged = `.[] | select(.merged_at != null and .base.ref == "${defaultBranch}") | [.number, .user.login, .html_url, .title] | @tsv`;
      return lines(api(`/commits/${commit}/pulls`, merged)).map((line): PullRequest => {
        const [number = "", author = "", url = "", title = ""] = line.split("\t");
        return { number: Number(number), title, author, url };
      });
    },
  };
}

function output(values: Record<string, string>): void {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  console.log(lines.join("\n"));
  const file = process.env["GITHUB_OUTPUT"];
  if (file) appendFileSync(file, `${lines.join("\n")}\n`);
}

function summary(markdown: string): void {
  const file = process.env["GITHUB_STEP_SUMMARY"];
  if (file) appendFileSync(file, `${markdown}\n`);
}

function outputPlan(plan: Plan | Skip): void {
  if ("skip" in plan) {
    console.log(`${plan.warning ? "::warning::" : ""}${plan.skip}`);
    summary(`No nightly: ${plan.skip}`);
    output({ skip: "true" });
    return;
  }
  summary(
    `${plan.channel === "stable" ? "Stable" : "Nightly"} ${plan.version} from \`${plan.sha}\``,
  );
  output({
    skip: "false",
    channel: plan.channel,
    version: plan.version,
    tag: plan.tag,
    sha: plan.sha,
    "previous-tag": plan.previousTag ?? "",
  });
}

/** Logs what a scheduled nightly and a stable release would do right now, for dry runs. */
async function reportChannels(repo: Repository, request: NightlyRequest): Promise<void> {
  const ref = `refs/heads/${repo.defaultBranch}`;
  const describe = (plan: Plan | Skip) =>
    "skip" in plan ? `skips. ${plan.skip}` : `builds ${plan.version} from ${plan.sha}.`;
  const refused = (error: unknown) =>
    `is refused. ${error instanceof Error ? error.message : String(error)}`;
  const sha = await repo.commitOf(repo.defaultBranch);
  const nightly = await planNightly(repo, {
    ...request,
    ref,
    sha,
    scheduled: true,
    dryRun: false,
  }).then(describe, refused);
  const stable = await planStable(repo, { ref }).then(describe, refused);
  console.log(`A scheduled nightly now ${nightly}\nA stable release now ${stable}`);
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      ref: { type: "string" },
      sha: { type: "string" },
      run: { type: "string" },
      version: { type: "string" },
      tag: { type: "string" },
      "previous-tag": { type: "string" },
      scheduled: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const [command] = positionals;
  const ref = values.ref ?? "";

  switch (command) {
    case "nightly": {
      const repo = githubRepository();
      const recorded: unknown = JSON.parse(readFileSync("package.json", "utf8")).version;
      const request: NightlyRequest = {
        ref,
        sha: values.sha ?? "",
        run: Number(values.run),
        now: Date.now(),
        recorded: String(recorded),
        scheduled: values.scheduled,
        dryRun: values["dry-run"],
      };
      outputPlan(await planNightly(repo, request));
      if (request.dryRun) await reportChannels(repo, request);
      return;
    }
    case "stable":
      outputPlan(
        await planStable(githubRepository(), { ref, version: values.version || undefined }),
      );
      return;
    case "check":
      checkUnreleased(githubRepository(), values.version ?? "");
      console.log(`${values.version} is still new.`);
      return;
    case "notes":
      console.log(
        await releaseNotes(githubRepository(), {
          tag: values.tag ?? "",
          sha: values.sha ?? "",
          previousTag: values["previous-tag"] || null,
        }),
      );
      return;
    case "record": {
      const manifest: Record<string, unknown> = JSON.parse(readFileSync("package.json", "utf8"));
      const next = recordedVersion(String(manifest.version), values.version ?? "");
      if (next) {
        writeFileSync(
          "package.json",
          `${JSON.stringify({ ...manifest, version: next }, null, 2)}\n`,
        );
      }
      console.log(
        next
          ? `package.json now records ${next}.`
          : `package.json already records ${manifest.version}.`,
      );
      return;
    }
    default:
      throw new Error(`Unknown command "${command}". Use nightly, stable, check, notes or record.`);
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.log(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
