import { describe, expect, it } from "vitest";
import {
  checkUnreleased,
  planNightly,
  planStable,
  recordedVersion,
  type History,
  type NightlyRequest,
  type Release,
  type Repository,
} from "../scripts/release-plan.ts";
import { compareVersions, formatVersion, parseVersion } from "../src/shared/version.ts";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-02T12:00:00Z");
const MAIN = "refs/heads/main";

function published(tag: string, hoursAgo: number, prerelease = tag.includes("-")): Release {
  return {
    tag,
    draft: false,
    prerelease,
    publishedAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
  };
}

function draft(tag: string): Release {
  return { tag, draft: true, prerelease: tag.includes("-"), publishedAt: null };
}

/** A repository whose releases have tags, as on GitHub. Comparisons and commits it wasn't told about throw. */
function repository(
  options: {
    releases?: Release[];
    tags?: string[];
    histories?: Record<string, History>;
    commits?: Record<string, string>;
  } = {},
) {
  const { releases = [], histories = {}, commits = {} } = options;
  const compared: string[] = [];
  const repo: Repository = {
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
  };
  return { repo, compared };
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

  it("count from a stable release main has not recorded yet", async () => {
    const { repo } = repository({ releases: [published("v0.0.1", 1)] });

    expect(
      await planNightly(repo, scheduled({ recorded: "0.0.0", scheduled: false })),
    ).toMatchObject({ version: "0.0.2-nightly.20261002.40" });
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
  const promotion = (releases: Release[] = []) =>
    repository({
      releases: [published(older, 30), published(latest, 8), ...releases],
      commits: { [latest]: "nightly-commit", main: "newer-commit" },
      histories: { "nightly-commit...main": "ahead" },
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
