import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { packageVersion } from "../packages/contracts/src/package-version.ts";
import { verifyPackage, type StoreRelease } from "../scripts/store-release.ts";
import {
  keyExpiry,
  preflight,
  status,
  StoreError,
  storeNotes,
  submit,
  type CheckedRelease,
} from "../scripts/store-submission.ts";
import { readZipEntry } from "../scripts/zip.ts";
import { fakeStore, removeArtifacts, writeArtifact } from "./fake-store.ts";

// A submission can't be tried without sending one, so these talk to a stand-in for Microsoft and
// check what reaches it: which requests, in what order, and with what in them.

const COMMIT = "5f3a9c".padEnd(40, "0");
const NOTES = [
  "**Stable** · built from `5f3a9c000000`",
  "",
  "Download the DMG on Mac, the setup .exe on Windows, and the AppImage or .deb on Linux.",
  "",
  "## What's Changed",
  "* Show the subtitle where a movie skips to by @wout in https://github.com/owner/app/pull/118",
  "* Keep the guide's place by @someone-else in https://github.com/owner/app/pull/119",
  "",
  "**Full Changelog**: https://github.com/owner/app/compare/v0.0.4...v0.0.5",
].join("\n");
const WHATS_NEW = "- Show the subtitle where a movie skips to\n- Keep the guide's place";

/** The published stable release `version`, as the Store job's first step hands it on. */
function released(version = "0.0.5"): StoreRelease {
  return {
    version,
    tag: `v${version}`,
    commit: COMMIT,
    packageVersion: packageVersion(version),
    notes: NOTES,
    run: 77,
  };
}

/** That release with a package built for it, checked as the Store job checks one. */
function checked(version = "0.0.5", padding = 0): CheckedRelease {
  const release = released(version);
  const { dir } = writeArtifact({ ...release, padding });
  return { ...release, package: verifyPackage(release, dir) };
}

/** What a refused submission says. Fails when it wasn't refused. */
async function refusal(attempt: Promise<unknown>): Promise<string> {
  const error: unknown = await attempt.then(
    () => new Error("It went through."),
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(StoreError);
  return error instanceof Error ? error.message : "";
}

/** The package in the ZIP uploaded for submission 1002, the first one a fake Store creates. */
function uploadedPackage(store: ReturnType<typeof fakeStore>, release: CheckedRelease) {
  const zip = store.uploaded("1002");
  return zip && readZipEntry(zip, release.package.fileName);
}

afterAll(removeArtifacts);

describe("submitting a stable release", () => {
  it("copies the published submission, changes the package and What's new, uploads and commits", async () => {
    const store = fakeStore();
    const release = checked();
    const { applicationPackages: offered, listings, ...kept } = structuredClone(store.published());

    const outcome = await submit(store.access(), release);

    expect(outcome).toEqual({
      version: "0.0.5",
      commit: COMMIT,
      packageVersion: "1.0.5.0",
      fileName: release.package.fileName,
      submissionId: "1002",
      status: "PreProcessing",
      stage: "in-progress",
      remarks: [],
    });
    expect(store.writes()).toEqual([
      "POST /submissions",
      "PUT /submissions/1002",
      "PUT block",
      "PUT blocklist",
      "POST /submissions/1002/commit",
    ]);

    const sent = store.sent("PUT /submissions/1002");
    // The copy as Microsoft made it: the trailer, the price, the audience and a field its
    // documentation doesn't name all go back untouched.
    const { applicationPackages, listings: sentListings, ...rest } = sent;
    expect(rest).toEqual({
      ...kept,
      id: "1002",
      status: "PendingCommit",
      friendlyName: "Submission 1002",
      fileUploadUrl: expect.stringContaining("upload-1002"),
    });
    expect(rest).toMatchObject({ visibility: "Public", targetPublishMode: "Immediate" });
    // The listing as it was, screenshots included, but for the notes.
    expect(sentListings).toEqual(
      JSON.parse(
        JSON.stringify(listings).replace('"What 0.0.4 changed."', JSON.stringify(WHATS_NEW)),
      ),
    );
    expect(applicationPackages).toEqual([
      { ...offered[0], fileStatus: "PendingDelete" },
      {
        fileName: release.package.fileName,
        fileStatus: "PendingUpload",
        minimumDirectXVersion: "None",
        minimumSystemRam: "None",
      },
    ]);

    expect(uploadedPackage(store, release)?.equals(readFileSync(release.package.path))).toBe(true);
  });

  it("uploads a package larger than one block whole", async () => {
    const store = fakeStore();
    const release = checked("0.0.5", 4 * 1024 * 1024);

    await submit(store.access(), release);

    expect(store.writes().filter((name) => name === "PUT block")).toHaveLength(2);
    expect(uploadedPackage(store, release)?.equals(readFileSync(release.package.path))).toBe(true);
  });

  it("names the package after the release's commit and the file's checksum", () => {
    const { fileName, sha256 } = checked().package;

    expect(fileName).toBe(`Mr-Streamer-0.0.5-win-x64.5f3a9c000000.${sha256.slice(0, 16)}.msix`);
  });

  it("stops waiting for Microsoft to take the commit after ten minutes", async () => {
    const store = fakeStore();
    store.progress(...Array.from({ length: 100 }, () => "CommitStarted"));

    const outcome = await submit(store.access(), checked());

    expect(outcome).toMatchObject({ status: "CommitStarted", stage: "in-progress" });
    expect(store.waits.reduce((total, ms) => total + ms, 0)).toBe(10 * 60 * 1000);
  });

  it("fails when Microsoft refuses the commit, with what Microsoft says", async () => {
    const store = fakeStore();
    store.progress("CommitStarted", {
      status: "CommitFailed",
      errors: [{ code: "InvalidState", details: "The package targets no device family." }],
    });

    expect(await submit(store.access(), checked())).toMatchObject({
      submissionId: "1002",
      status: "CommitFailed",
      stage: "failed",
      remarks: ["Error: InvalidState: The package targets no device family."],
    });
  });
});

describe("running a submission again", () => {
  it("reports a release the Store has, in certification or published, and sends nothing", async () => {
    const store = fakeStore();
    const release = checked();
    await submit(store.access(), release);
    const sentOnce = store.requests.length;

    store.advance("Certification");
    expect(await submit(store.access(), release)).toMatchObject({
      submissionId: "1002",
      status: "Certification",
      stage: "in-progress",
    });
    store.advance("Published");
    expect(await submit(store.access(), release)).toMatchObject({
      submissionId: "1002",
      status: "Published",
      stage: "live",
    });
    expect(store.writes(sentOnce)).toEqual([]);
  });

  it("reports a certification Microsoft failed as a failure, and leaves the submission alone", async () => {
    const store = fakeStore();
    const release = checked();
    await submit(store.access(), release);
    const sentOnce = store.requests.length;
    store.advance({
      status: "CertificationFailed",
      errors: [{ code: "PolicyViolation", details: "10.2.4: the app needs a provider." }],
    });

    expect(await submit(store.access(), release)).toMatchObject({
      status: "CertificationFailed",
      stage: "failed",
      remarks: ["Error: PolicyViolation: 10.2.4: the app needs a provider."],
    });
    expect(store.writes(sentOnce)).toEqual([]);
  });

  it("commits the draft an interrupted run left, without creating another", async () => {
    const store = fakeStore();
    const release = checked();
    store.fail("POST /submissions/1002/commit", "unanswered");

    expect(await refusal(submit(store.access(), release))).toContain("still a draft");
    const interrupted = store.requests.length;
    const outcome = await submit(store.access(), release);

    expect(outcome).toMatchObject({ submissionId: "1002", stage: "in-progress" });
    expect(store.writes(interrupted)).toEqual([
      "PUT block",
      "PUT blocklist",
      "POST /submissions/1002/commit",
    ]);
  });

  it("takes a commit that went through although its answer was lost, without committing twice", async () => {
    const store = fakeStore();
    store.fail("POST /submissions/1002/commit", "lost");

    expect(await submit(store.access(), checked())).toMatchObject({
      submissionId: "1002",
      status: "PreProcessing",
      stage: "in-progress",
    });
    expect(store.writes().filter((name) => name.endsWith("/commit"))).toHaveLength(1);
  });

  it("neither adopts nor deletes a submission whose creation got no answer", async () => {
    const store = fakeStore();
    const release = checked();
    store.fail("POST /submissions", "lost");

    expect(await refusal(submit(store.access(), release))).toContain(
      "submission 1002 is in progress now. Nothing shows whether this run made it",
    );
    expect(await refusal(submit(store.access(), release))).toContain("Submission 1002");
    // One request to create, never repeated, and the copy is left for a person to judge.
    expect(store.writes()).toEqual(["POST /submissions"]);
  });

  it("says so when a creation never reached Microsoft, and creates on the next run", async () => {
    const store = fakeStore();
    const release = checked();
    store.fail("POST /submissions", "unanswered");

    expect(await refusal(submit(store.access(), release))).toContain("has none in progress");
    expect(await submit(store.access(), release)).toMatchObject({ submissionId: "1002" });
  });

  it("repeats a read Microsoft failed to answer", async () => {
    const store = fakeStore();
    store.fail("GET /", 503);

    expect(await submit(store.access(), checked())).toMatchObject({ stage: "in-progress" });
    expect(store.requests.slice(0, 3)).toEqual(["POST token", "GET /", "GET /"]);
  });
});

describe("what a submission is refused for", () => {
  it("another submission in progress, whoever made it", async () => {
    const store = fakeStore();
    const other = store.start("Certification", "Mr-Streamer-0.0.5-win-x64.msix", "1.0.5.0");

    const message = await refusal(submit(store.access(), checked("0.0.6")));

    expect(message).toContain(`Submission ${other} is in progress (Certification)`);
    expect(store.writes()).toEqual([]);
  });

  it("a package the Store's own doesn't sort before", async () => {
    const store = fakeStore();

    // The Store offers 0.0.4's package, from a file this automation didn't name.
    expect(await refusal(submit(store.access(), checked("0.0.4")))).toContain(
      "The Store offers package 1.0.4.0 already",
    );
    expect(await refusal(submit(store.access(), checked("0.0.3")))).toContain(
      "1.0.3.0 doesn't sort after it",
    );
    expect(store.writes()).toEqual([]);
  });

  it.each([
    ["audience", { visibility: "Private" }],
    ["publishing mode", { targetPublishMode: "Manual" }],
  ])("a listing whose %s isn't Public and Immediate, which it never sets", async (_, change) => {
    const store = fakeStore();
    store.edit(change);

    expect(await refusal(submit(store.access(), checked()))).toContain(
      "only updates a Public listing that publishes as soon as it is certified",
    );
    expect(store.writes()).toEqual([]);
  });

  it("an application ID that isn't Mr. Streamer's package", async () => {
    const store = fakeStore();
    store.rename({ packageIdentityName: "Someone.Else" });

    expect(await refusal(submit(store.access(), checked()))).toContain(
      "isn't MrStreamerOSS.Mr.Streamer by CN=A132E842-C4C9-40BF-83C4-D304E7952C2D in this account, so nothing is sent to it. Microsoft names it Someone.Else",
    );
    expect(store.writes()).toEqual([]);
  });

  it("a key Microsoft Entra doesn't take", async () => {
    const store = fakeStore();

    const message = await refusal(submit(store.access({ clientSecret: "wrong" }), checked()));

    expect(message).toContain("refused the sign-in (invalid_client, AADSTS7000215)");
    expect(store.requests).toEqual(["POST token"]);
  });
});

describe("what a failure prints", () => {
  it("Microsoft's own error without the key, the token or an upload address in it", async () => {
    const store = fakeStore();
    const [key, token, signature] = store.secrets;
    store.fail(
      "PUT /submissions/1002",
      400,
      JSON.stringify({
        code: "BadRequest",
        message: `Bearer ${token} with ${key} at https://ingestion.blob.core.windows.net/a?sig=${signature} is invalid.`,
      }),
    );

    const message = await refusal(submit(store.access(), checked()));

    expect(message).toContain(
      "Microsoft says: BadRequest: Bearer [hidden] with [hidden] at [address]",
    );
    for (const secret of store.secrets) expect(message).not.toContain(secret);
  });

  it("nothing of an answer whose shape it doesn't know", async () => {
    const store = fakeStore();
    store.fail("GET /", 403, `<html>Denied for ${store.secrets[0]}: see /internal/trace</html>`);

    const message = await refusal(submit(store.access(), checked()));

    expect(message).toBe(
      "Microsoft answered HTTP 403 to reading the app. The application lacks the Manager role in Partner Center.",
    );
  });

  it("an upload that failed without its address", async () => {
    const store = fakeStore();
    store.fail("PUT block", 403, "AuthenticationFailed");

    const message = await refusal(submit(store.access(), checked()));

    expect(message).toContain("was refused with HTTP 403");
    expect(message).not.toContain("blob.core");
    for (const secret of store.secrets) expect(message).not.toContain(secret);
  });
});

describe("reading where a release stands", () => {
  it("follows a submission from certification to published, and reads only", async () => {
    const store = fakeStore();
    await submit(store.access(), checked());
    const sentOnce = store.requests.length;
    const release = released();

    store.advance("Certification");
    expect(await status(store.access(), release)).toMatchObject({
      submissionId: "1002",
      status: "Certification",
      stage: "in-progress",
    });
    store.advance("Published");
    expect(await status(store.access(), release)).toMatchObject({
      submissionId: "1002",
      packageVersion: "1.0.5.0",
      status: "Published",
      stage: "live",
    });
    expect(store.writes(sentOnce)).toEqual([]);
  });

  it("says a release was never submitted, and what the Store offers instead", async () => {
    const store = fakeStore();

    expect(await status(store.access(), released("0.0.6"))).toEqual({
      version: "0.0.6",
      commit: COMMIT,
      packageVersion: "1.0.6.0",
      fileName: null,
      submissionId: null,
      status: null,
      stage: "absent",
      remarks: ["The Store offers 1.0.4.0, from submission 1001."],
    });
  });

  it("finds a package someone uploaded in Partner Center by its version, and says so", async () => {
    const store = fakeStore();
    const byHand = store.start("Certification", "Mr-Streamer-0.0.5-win-x64.msix", "1.0.5.0");

    const outcome = await status(store.access(), released());

    expect(outcome).toMatchObject({ submissionId: byHand, stage: "in-progress" });
    expect(outcome.remarks.join(" ")).toContain("uploaded another way");
  });
});

describe("the preflight", () => {
  it("says what the account holds and what a submission would do, and changes nothing", async () => {
    const store = fakeStore();
    const release = checked();

    const { found, problems } = await preflight(store.access(), release);

    expect(problems).toEqual([]);
    expect(found).toEqual([
      "Signed in. Application 9N45GG76ZP4T is MrStreamerOSS.Mr.Streamer.",
      "Published: submission 1001, Public, publishing Immediate.",
      "Package Mr-Streamer-0.0.4-win-x64.msix: 1.0.4.0.",
      "Listings: en-us with 2 image(s). Trailers: 1.",
      "Price: Free.",
      "No submission in progress.",
      `0.0.5 would go in a new submission, as ${release.package.fileName}.`,
    ]);
    expect(store.writes()).toEqual([]);
  });

  it("names what would stop a submission", async () => {
    const store = fakeStore();
    store.edit({ visibility: "Private" });
    expect((await preflight(store.access(), null)).problems).toEqual([
      expect.stringContaining('has the audience "Private"'),
    ]);

    const busy = fakeStore();
    busy.start("Certification", "Mr-Streamer-0.0.5-win-x64.msix", "1.0.5.0");
    expect((await preflight(busy.access(), checked("0.0.6"))).problems).toEqual([
      expect.stringContaining("is in progress (Certification)"),
    ]);
  });
});

describe("What's new in the Store", () => {
  it("lists the titles of the release's changes, without authors and links", () => {
    expect(storeNotes(released())).toBe(WHATS_NEW);
  });

  it("keeps to the 1500 characters the Store takes, in whole titles", () => {
    const title = "A change with a title of some length";
    const notes = Array.from(
      { length: 80 },
      (_, index) => `* ${title} ${index} by @wout in https://github.com/owner/app/pull/${index}`,
    ).join("\n");

    const whatsNew = storeNotes({ version: "0.0.5", notes });

    expect(whatsNew.length).toBeLessThanOrEqual(1500);
    expect(whatsNew.split("\n").at(-1)).toMatch(/^- A change with a title of some length \d+$/);
  });

  it("names the version when the notes list no change", () => {
    expect(storeNotes({ version: "0.0.5", notes: "**Stable**" })).toBe("Mr. Streamer 0.0.5.");
  });
});

describe("the day the key ends", () => {
  const now = Date.parse("2026-10-05T12:00:00Z");

  it("is worth a warning from 30 days before, and after", () => {
    expect(keyExpiry("2027-10-05", now)).toBeNull();
    expect(keyExpiry("2026-10-20", now)).toContain("ends on 2026-10-20, in 15 days");
    expect(keyExpiry("2026-10-01", now)).toContain("ended on 2026-10-01");
  });

  it("is asked for when nobody recorded it", () => {
    expect(keyExpiry(undefined, now)).toContain("No day is recorded");
    expect(keyExpiry("next year", now)).toContain("No day is recorded");
  });
});
