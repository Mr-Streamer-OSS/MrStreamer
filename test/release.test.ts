import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  checkUnreleased,
  deployedFeed,
  planNightly,
  planStable,
  recordedVersion,
  releaseNotes,
  type History,
  type NightlyRequest,
  type PullRequest,
  type Repository,
} from "../scripts/release-plan.ts";
import { compareVersions, formatVersion, parseVersion } from "../packages/contracts/src/version.ts";
import {
  buildFeed,
  mergeFeeds,
  readFeed,
  type GitHubRelease,
  type UpdateFeed,
} from "../packages/contracts/src/update-feed.ts";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-02T12:00:00Z");
const MAIN = "refs/heads/main";
const REPOSITORY = "https://github.com/owner/app";

/** A published release with every platform's files. */
function published(tag: string, hoursAgo: number, prerelease = tag.includes("-")): GitHubRelease {
  return {
    tag,
    draft: false,
    prerelease,
    publishedAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
    page: `${REPOSITORY}/releases/tag/${tag}`,
    notes: `Notes for ${tag}`,
    assets: [`Mr-Streamer-${tag}.dmg`, "latest-mac.yml", "latest.yml", "latest-linux.yml"],
  };
}

function draft(tag: string): GitHubRelease {
  return { ...published(tag, 0), draft: true, publishedAt: null };
}

/**
 * A repository whose releases have tags, as on GitHub. Comparisons and commits it wasn't told
 * about throw. `history` is main's commits, oldest first, and `pulls` the pull requests merged
 * with each commit.
 */
function repository(
  options: {
    releases?: GitHubRelease[];
    tags?: string[];
    histories?: Record<string, History>;
    commits?: Record<string, string>;
    history?: string[];
    pulls?: Record<string, number[]>;
  } = {},
) {
  const { releases = [], histories = {}, commits = {}, history = [], pulls = {} } = options;
  const compared: string[] = [];
  /** The position of a tag's or commit's commit on main. */
  const position = (ref: string) => {
    const index = history.indexOf(commits[ref] ?? ref);
    if (index === -1) throw new Error(`Unknown commit ${ref}`);
    return index;
  };
  const repo: Repository = {
    url: REPOSITORY,
    defaultBranch: "main",
    releases,
    tags: [
      ...releases.filter((release) => !release.draft).map((release) => release.tag),
      ...(options.tags ?? []),
    ],
    async compare(base, head) {
      compared.push(`${base}...${head}`);
      const history = histories[`${base}...${head}`];
      if (!history) throw new Error(`Unexpected comparison ${base}...${head}`);
      return history;
    },
    async commitOf(tag) {
      const commit = commits[tag];
      if (!commit) throw new Error(`Unknown tag ${tag}`);
      return commit;
    },
    async commits(base, head) {
      return history.slice(base === null ? 0 : position(base) + 1, position(head) + 1);
    },
    async pullRequestsOf(commit) {
      return (pulls[commit] ?? []).map(pull);
    },
  };
  return { repo, compared };
}

function pull(number: number): PullRequest {
  return {
    number,
    title: `Change ${number}`,
    author: "wout",
    url: `https://github.com/owner/app/pull/${number}`,
  };
}

/** The pull request numbers notes list, in order. */
function listed(notes: string): number[] {
  return [...notes.matchAll(/\/pull\/(\d+)$/gm)].map((match) => Number(match[1]));
}

const scheduled = (overrides: Partial<NightlyRequest> = {}): NightlyRequest => ({
  ref: MAIN,
  sha: "head",
  run: 40,
  now: NOW,
  recorded: "0.0.0",
  scheduled: true,
  dryRun: false,
  ...overrides,
});

describe("scheduled nightlies", () => {
  it("builds the first nightly", async () => {
    const { repo } = repository();

    expect(await planNightly(repo, scheduled())).toEqual({
      channel: "nightly",
      version: "0.0.1-nightly.20261002.40",
      tag: "v0.0.1-nightly.20261002.40",
      sha: "head",
      previousTag: null,
    });
  });

  it("waits six hours after the previous nightly, then builds when main has new commits", async () => {
    const last = "v0.0.1-nightly.20261002.30";
    const early = repository({ releases: [published(last, 5.99)] });
    const due = repository({
      releases: [published(last, 6)],
      histories: { [`${last}...head`]: "ahead" },
    });

    expect(await planNightly(early.repo, scheduled())).toMatchObject({ skip: expect.any(String) });
    expect(early.compared).toEqual([]);
    expect(await planNightly(due.repo, scheduled())).toMatchObject({
      version: "0.0.1-nightly.20261002.40",
      previousTag: last,
    });
  });

  it("skips when main has nothing new, or is behind or apart from the last nightly", async () => {
    const last = "v0.0.1-nightly.20261001.30";
    const plan = (history: History) =>
      planNightly(
        repository({ releases: [published(last, 7)], histories: { [`${last}...head`]: history } })
          .repo,
        scheduled(),
      );

    expect(await plan("identical")).toMatchObject({ warning: false });
    expect(await plan("behind")).toMatchObject({ warning: false });
    expect(await plan("diverged")).toMatchObject({
      skip: expect.stringContaining("no longer contains"),
      warning: true,
    });
  });

  it("measures from the last published nightly, not drafts or other pre-releases", async () => {
    const last = "v0.0.1-nightly.20261001.30";
    const { repo, compared } = repository({
      releases: [
        published(last, 7),
        draft("v0.0.1-nightly.20261002.35"),
        published("v0.0.1-beta.1", 1),
        published("v0.0.1-nightly.20261002.36", 1, false),
      ],
      histories: { [`${last}...head`]: "ahead" },
    });

    expect(await planNightly(repo, scheduled())).toMatchObject({ previousTag: last });
    expect(compared).toEqual([`${last}...head`]);
  });

  it("builds a nightly started by hand right away", async () => {
    const { repo } = repository({ releases: [published("v0.0.1-nightly.20261002.39", 1)] });

    expect(await planNightly(repo, scheduled({ scheduled: false }))).toMatchObject({
      version: "0.0.1-nightly.20261002.40",
    });
  });

  it("refuses a nightly from another branch", async () => {
    const { repo } = repository();

    await expect(
      planNightly(repo, scheduled({ ref: "refs/heads/feature", scheduled: false })),
    ).rejects.toThrow("from main");
  });
});

describe("nightly versions", () => {
  it("preview the patch after the stable version main records", async () => {
    const { repo } = repository({ releases: [published("v0.1.0", 30)] });

    expect(
      await planNightly(repo, scheduled({ recorded: "0.1.0", scheduled: false })),
    ).toMatchObject({ version: "0.1.1-nightly.20261002.40" });
  });

  it("count from a stable release main has not recorded yet, such as one published while they waited in the queue", async () => {
    // The run started before the stable release, so its commit still records 0.0.1.
    const { repo } = repository({
      releases: [
        published("v0.0.1", 50, false),
        published("v0.0.2-nightly.20261002.30", 8),
        published("v0.0.2", 1, false),
      ],
    });

    expect(
      await planNightly(repo, scheduled({ recorded: "0.0.1", scheduled: false })),
    ).toMatchObject({ version: "0.0.3-nightly.20261002.40" });
  });

  it("are refused when the tag exists or would sort before a released nightly", async () => {
    const { repo } = repository({
      releases: [published("v0.0.1-nightly.20261002.40", 1)],
      tags: ["v0.0.1-nightly.20261002.41"],
    });

    await expect(planNightly(repo, scheduled({ scheduled: false }))).rejects.toThrow(
      "v0.0.1-nightly.20261002.40 already exists",
    );
    await expect(planNightly(repo, scheduled({ run: 39, scheduled: false }))).rejects.toThrow(
      "would sort before 0.0.1-nightly.20261002.41",
    );
  });
});

describe("stable releases", () => {
  const older = "v0.0.1-nightly.20261001.20";
  const latest = "v0.0.1-nightly.20261002.30";
  const promotion = (releases: GitHubRelease[] = []) =>
    repository({
      releases: [published(older, 30), published(latest, 8), ...releases],
      commits: { [older]: "older-commit", [latest]: "nightly-commit", main: "newer-commit" },
      histories: { "older-commit...main": "ahead", "nightly-commit...main": "ahead" },
    });

  it("rebuild the commit of the latest nightly while main moves on", async () => {
    const { repo } = promotion();

    expect(await planStable(repo, { ref: MAIN })).toEqual({
      channel: "stable",
      version: "0.0.1",
      tag: "v0.0.1",
      sha: "nightly-commit",
      previousTag: null,
    });
  });

  it("promote the tested nightly when given, by version or tag", async () => {
    const { repo } = promotion();

    for (const nightly of ["0.0.1-nightly.20261001.20", older]) {
      expect(await planStable(repo, { ref: MAIN, nightly })).toMatchObject({
        version: "0.0.1",
        sha: "older-commit",
      });
    }
  });

  it("refuse a given nightly that is a draft, unknown, stable or not on main", async () => {
    const { repo } = repository({
      releases: [
        published("v0.0.0", 50, false),
        published(latest, 8),
        draft("v0.0.1-nightly.20261002.31"),
      ],
      commits: { [latest]: "rewritten" },
      histories: { "rewritten...main": "diverged" },
    });
    const pinned = (nightly: string) => planStable(repo, { ref: MAIN, nightly });

    await expect(pinned("0.0.1-nightly.20261002.31")).rejects.toThrow("not a published nightly");
    await expect(pinned("0.0.1-nightly.20261002.99")).rejects.toThrow(
      "No release is tagged v0.0.1-nightly.20261002.99",
    );
    await expect(pinned("v0.0.0")).rejects.toThrow("not a nightly version");
    await expect(pinned(latest)).rejects.toThrow("main does not contain");
  });

  it("keep the nightly's commit when given another version", async () => {
    const { repo } = promotion();

    expect(await planStable(repo, { ref: MAIN, version: "0.1.0" })).toMatchObject({
      version: "0.1.0",
      sha: "nightly-commit",
    });
  });

  it("list the changes since the previous stable release", async () => {
    const { repo } = promotion([published("v0.0.0", 100, false), draft("v0.0.9")]);

    expect(await planStable(repo, { ref: MAIN })).toMatchObject({ previousTag: "v0.0.0" });
  });

  it("are refused without a published nightly", async () => {
    const { repo } = repository({ releases: [draft("v0.0.1-nightly.20261002.30")] });

    await expect(planStable(repo, { ref: MAIN })).rejects.toThrow("No published nightly");
  });

  it("are refused when main does not contain the nightly's commit", async () => {
    const { repo } = repository({
      releases: [published(latest, 8)],
      commits: { [latest]: "rewritten" },
      histories: { "rewritten...main": "diverged" },
    });

    await expect(planStable(repo, { ref: MAIN })).rejects.toThrow("main does not contain");
  });

  it("are refused for a released version, or one that would sort before the nightly", async () => {
    const { repo } = promotion([published("v0.0.1", 2, false)]);

    await expect(planStable(repo, { ref: MAIN })).rejects.toThrow("v0.0.1 already exists");
    await expect(planStable(repo, { ref: MAIN, version: "0.0.0" })).rejects.toThrow(
      "would sort before v0.0.1-nightly.20261002.30",
    );
  });

  it("are refused for a nightly from before the newest stable release, whatever the version", async () => {
    const { repo } = promotion([published("v0.0.1", 2, false)]);

    await expect(planStable(repo, { ref: MAIN, nightly: older, version: "0.1.0" })).rejects.toThrow(
      `${older} came before v0.0.1`,
    );
  });
});

describe("release notes", () => {
  // main: c0 ... c6. Stable 0.1.0 shipped c1; nightlies followed at c3, c4 and c5; c6 landed after.
  // #13 arrived in two commits.
  const history = ["c0", "c1", "c2", "c3", "c4", "c5", "c6"];
  const pulls = { c0: [10], c1: [11], c2: [12], c3: [13], c4: [13, 14], c5: [15], c6: [16] };
  const nightlies = [
    published("v0.1.1-nightly.20261001.1", 30),
    published("v0.1.1-nightly.20261001.2", 20),
    published("v0.1.1-nightly.20261002.3", 8),
  ];
  const commits = {
    "v0.1.0": "c1",
    "v0.1.1-nightly.20261001.1": "c3",
    "v0.1.1-nightly.20261001.2": "c4",
    "v0.1.1-nightly.20261002.3": "c5",
    main: "c6",
  };

  it("list every change since the previous stable release up to the promoted nightly, once each", async () => {
    const { repo } = repository({
      releases: [published("v0.1.0", 100, false), ...nightlies],
      commits,
      histories: { "c5...main": "ahead" },
      history,
      pulls,
    });

    const plan = await planStable(repo, { ref: MAIN });
    const notes = await releaseNotes(repo, plan);

    expect(listed(notes)).toEqual([12, 13, 14, 15]);
    expect(notes).toContain("https://github.com/owner/app/compare/v0.1.0...v0.1.1");
  });

  it("list everything up to the promoted nightly for the first stable release", async () => {
    const { repo } = repository({
      releases: nightlies,
      commits,
      histories: { "c5...main": "ahead" },
      history,
      pulls,
    });

    const plan = await planStable(repo, { ref: MAIN });
    const notes = await releaseNotes(repo, plan);

    expect(plan.previousTag).toBeNull();
    expect(listed(notes)).toEqual([10, 11, 12, 13, 14, 15]);
    expect(notes).toContain("https://github.com/owner/app/commits/v0.1.1");
  });

  it("list only a nightly's own changes", async () => {
    const { repo } = repository({
      releases: [published("v0.1.0", 100, false), ...nightlies],
      commits,
      histories: { "v0.1.1-nightly.20261002.3...c6": "ahead" },
      history,
      pulls,
    });

    const plan = await planNightly(repo, scheduled({ sha: "c6", recorded: "0.1.0" }));
    if ("skip" in plan) throw new Error(plan.skip);

    expect(listed(await releaseNotes(repo, plan))).toEqual([16]);
  });
});

describe("publishing", () => {
  it("rechecks that a nightly still sorts after every release", () => {
    const { repo } = repository({ releases: [published("v0.0.1", 0.5, false)] });

    expect(() => checkUnreleased(repo, "0.0.1-nightly.20261002.40")).toThrow(
      "would sort before 0.0.1",
    );
    expect(() => checkUnreleased(repo, "0.0.2-nightly.20261002.40")).not.toThrow();
  });

  it("records a stable version on main only when it is newer", () => {
    expect(recordedVersion("0.0.0", "0.0.1")).toBe("0.0.1");
    expect(recordedVersion("0.0.1", "0.0.1")).toBeNull();
    expect(recordedVersion("0.1.0", "0.0.2")).toBeNull();
  });
});

describe("update feed", () => {
  const GENERATED = "2026-10-02T12:00:00.000Z";
  const feedOf = (releases: GitHubRelease[]) => buildFeed(REPOSITORY, releases, GENERATED);
  /** The versions a feed offers on Stable and Nightly. */
  const offered = (feed: UpdateFeed) => [feed.stable?.version, feed.nightly?.version];

  it("offers the highest stable release on Stable, and the highest of all on Nightly", () => {
    const releases = [
      published("v0.0.1", 50, false),
      published("v0.0.2-nightly.20261001.20", 30),
      published("v0.0.2", 20, false),
    ];

    expect(offered(feedOf(releases))).toEqual(["0.0.2", "0.0.2"]);
    expect(offered(feedOf([...releases, published("v0.0.3-nightly.20261002.30", 2)]))).toEqual([
      "0.0.2",
      "0.0.3-nightly.20261002.30",
    ]);
    expect(offered(feedOf([]))).toEqual([undefined, undefined]);
  });

  it("points at each release's page, download folder and notes", () => {
    expect(feedOf([published("v0.0.2", 20, false)])).toEqual({
      schema: 1,
      generated: GENERATED,
      stable: {
        version: "0.0.2",
        published: new Date(NOW - 20 * HOUR).toISOString(),
        page: "https://github.com/owner/app/releases/tag/v0.0.2",
        files: "https://github.com/owner/app/releases/download/v0.0.2",
        notes: "Notes for v0.0.2",
        platforms: ["latest-mac.yml", "latest.yml", "latest-linux.yml"],
      },
      nightly: expect.objectContaining({ version: "0.0.2" }),
    });
  });

  it("leaves out drafts, mismatched pre-release flags and releases missing a platform", () => {
    const feed = feedOf([
      published("v0.0.1", 50, false),
      draft("v0.0.9"),
      published("v0.0.8", 1, true),
      published("v0.0.8-nightly.20261002.8", 1, false),
      { ...published("v0.0.7", 1, false), assets: ["latest-mac.yml", "latest.yml"] },
      published("v0.1.0-beta.1", 1),
    ]);

    expect(offered(feed)).toEqual(["0.0.1", "0.0.1"]);
  });

  it("orders by version, never by date", () => {
    const feed = feedOf([
      published("v0.0.10", 30, false),
      published("v0.0.9", 1, false),
      published("v0.0.11-nightly.20261002.40", 5),
      published("v0.0.11-nightly.20261002.39", 1),
    ]);

    expect(offered(feed)).toEqual(["0.0.10", "0.0.11-nightly.20261002.40"]);
  });

  it("never moves a channel to a lower version than the deployed feed names", () => {
    const deployed = feedOf([
      published("v0.0.3", 5, false),
      published("v0.0.4-nightly.20261002.9", 1),
    ]);

    expect(offered(mergeFeeds(deployed, feedOf([published("v0.0.2", 20, false)])))).toEqual([
      "0.0.3",
      "0.0.4-nightly.20261002.9",
    ]);
    expect(offered(mergeFeeds(deployed, feedOf([])))).toEqual([
      "0.0.3",
      "0.0.4-nightly.20261002.9",
    ]);
  });

  it("takes newer releases and the latest details of the same one", () => {
    const deployed = feedOf([{ ...published("v0.0.2", 20, false), notes: "Draft notes" }]);
    const listed = feedOf([
      published("v0.0.2", 20, false),
      published("v0.0.3-nightly.20261002.9", 1),
    ]);

    expect(mergeFeeds(deployed, listed)).toEqual(listed);
    expect(mergeFeeds(null, listed)).toEqual(listed);
  });

  it("moves back when allowed, to withdraw a deleted release", () => {
    const deployed = feedOf([published("v0.0.3", 5, false)]);
    const listed = feedOf([published("v0.0.2", 20, false)]);

    expect(mergeFeeds(deployed, listed, { allowRegress: true })).toEqual(listed);
  });

  it("reads the deployed feed, and stops when it can't tell whether one exists", async () => {
    const feed = feedOf([published("v0.0.3", 5, false)]);
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (path === "/updates.json") response.end(JSON.stringify(feed));
      else response.writeHead(path === "/missing.json" ? 404 : 503).end();
    });
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
    const site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect(await deployedFeed(`${site}/updates.json`)).toEqual(feed);
      // Nothing deployed yet: the releases alone decide.
      expect(await deployedFeed(`${site}/missing.json`)).toBeNull();
      expect(await deployedFeed(undefined)).toBeNull();
      await expect(deployedFeed(`${site}/busy.json`)).rejects.toThrow("HTTP 503");
    } finally {
      await new Promise((closed) => server.close(closed));
    }
    // Unreachable says nothing about what is deployed, so nothing is published.
    await expect(deployedFeed(`${site}/updates.json`)).rejects.toThrow("unreachable");
  });

  it("reads back the feed it writes, and nothing else", () => {
    const feed = feedOf([
      published("v0.0.2", 20, false),
      published("v0.0.3-nightly.20261002.9", 1),
    ]);
    const json: Record<string, unknown> = JSON.parse(JSON.stringify(feed));

    expect(readFeed(json)).toEqual(feed);
    expect(() => readFeed({ ...json, schema: 2 })).toThrow("schema 1");
    expect(() => readFeed({ ...json, stable: feed.nightly })).toThrow("stable release has version");
    expect(() => readFeed({ ...json, nightly: { ...feed.nightly, files: undefined } })).toThrow(
      "nightly release is malformed",
    );
  });
});

describe("release versions", () => {
  it("orders stable releases and the nightlies between them", () => {
    const shuffled = [
      "0.3.0",
      "0.3.0-nightly.20261002.14",
      "0.2.0",
      "0.10.0",
      "0.3.0-nightly.20261002.9",
      "0.3.0-nightly.20261001.20",
      "0.2.1",
    ];

    const sorted = shuffled
      .map((text) => parseVersion(text))
      .flatMap((version) => (version ? [version] : []))
      .sort(compareVersions)
      .map(formatVersion);

    expect(sorted).toEqual([
      "0.2.0",
      "0.2.1",
      "0.3.0-nightly.20261001.20",
      "0.3.0-nightly.20261002.9",
      "0.3.0-nightly.20261002.14",
      "0.3.0",
      "0.10.0",
    ]);
  });

  it("reads only the stable and nightly formats", () => {
    expect(parseVersion("v0.2.0")).toMatchObject({ minor: 2, nightly: null });
    expect(parseVersion("0.2.0-beta.1")).toBeNull();
    expect(parseVersion("0.2")).toBeNull();
  });
});
