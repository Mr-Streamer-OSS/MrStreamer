// Works out the release the release workflow prepares: version, tag and channel.
//
//   node scripts/release-plan.ts --channel nightly --version 0.3.0 --run 14
//
// A stable release is the version given. A nightly is the stable version it leads up to plus
// the UTC date and the workflow run: 0.3.0-nightly.20261002.14. The plan is refused when its tag
// exists, as a release, a draft or a tag, or when it would not sort after the newest stable
// release; so a nightly always leads up to a version stable has not reached yet. Reads releases
// and tags with gh and prints the plan as GitHub Actions outputs.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  channelOf,
  compareVersions,
  formatVersion,
  parseVersion,
  type Channel,
  type Version,
} from "../src/shared/version.ts";

export interface PlannedRelease {
  readonly version: string;
  readonly tag: string;
  readonly channel: Channel;
}

export interface ReleaseRequest {
  readonly channel: Channel;
  /** The stable version: the release itself, or the one a nightly leads up to. */
  readonly version: string;
  /** UTC date as YYYYMMDD. */
  readonly date: string;
  readonly run: number;
}

/** The release to prepare, given every tag in use. Throws with the reason when it is refused. */
export function planRelease(request: ReleaseRequest, tags: readonly string[]): PlannedRelease {
  const base = parseVersion(request.version);
  if (!base || base.nightly) {
    throw new Error(`"${request.version}" is not a stable version such as 0.2.0.`);
  }
  const version: Version =
    request.channel === "nightly"
      ? { ...base, nightly: { date: Number(request.date), run: request.run } }
      : base;
  const tag = `v${formatVersion(version)}`;
  if (tags.includes(tag)) throw new Error(`${tag} already exists.`);

  const newestStable = tags
    .map(parseVersion)
    .filter((parsed): parsed is Version => parsed !== null && channelOf(parsed) === "stable")
    .sort(compareVersions)
    .at(-1);
  if (newestStable && compareVersions(version, newestStable) <= 0) {
    throw new Error(
      request.channel === "nightly"
        ? `A nightly has to lead up to a version after ${formatVersion(newestStable)}, the newest stable release.`
        : `${formatVersion(version)} is not newer than ${formatVersion(newestStable)}, the newest stable release.`,
    );
  }
  return { version: formatVersion(version), tag, channel: request.channel };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      channel: { type: "string" },
      version: { type: "string" },
      run: { type: "string" },
    },
  });
  if (values.channel !== "stable" && values.channel !== "nightly") {
    throw new Error("--channel must be stable or nightly.");
  }
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const list = (path: string, field: string) =>
    execFileSync("gh", ["api", "--paginate", path, "--jq", `.[].${field}`], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  // Drafts have no tag yet, so their release names count too.
  const tags = [
    ...list("repos/{owner}/{repo}/releases?per_page=100", "tag_name"),
    ...list("repos/{owner}/{repo}/tags?per_page=100", "name"),
  ];
  const plan = planRelease(
    { channel: values.channel, version: values.version ?? "", date, run: Number(values.run) },
    tags,
  );
  const outputs = Object.entries(plan).map(([key, value]) => `${key}=${value}`);
  console.log(outputs.join("\n"));
  if (process.env["GITHUB_OUTPUT"])
    appendFileSync(process.env["GITHUB_OUTPUT"], `${outputs.join("\n")}\n`);
}
