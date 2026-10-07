import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { packageVersion } from "../packages/contracts/src/package-version.ts";
import { STORE_NAME, verifyPackage, type StoreRelease } from "../scripts/store-release.ts";
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
import { fakeStore, removeArtifacts, writeArtifact, type Built } from "./fake-store.ts";

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

/**
 * That release with a package built for it, checked as the Store job checks one. `built` says
 * where the package differs from one built today.
 */
function checked(version = "0.0.5", built: Partial<Built> = {}): CheckedRelease {
  const release = released(version);
  const { dir } = writeArtifact({ ...release, ...built });
  return { ...release, package: verifyPackage(release, dir) };
}

/**
 * `listings` as a submission sends them back: every language's "What's new" replaced, its title
 * too when the submission gives it `title`, and nothing else.
 */
function relisted(listings: unknown, title?: string): unknown {
  const noted = JSON.stringify(listings).replaceAll(
    /"releaseNotes":"[^"]*"/g,
    `"releaseNotes":${JSON.stringify(WHATS_NEW)}`,
  );
  return JSON.parse(
    title ? noted.replaceAll(/"title":"[^"]*"/g, `"title":${JSON.stringify(title)}`) : noted,
  );
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

/**
 * The package in the ZIP uploaded for submission 1002, the first one a fake Store creates, under
 * the name it has there.
 */
function uploadedPackage(
  store: ReturnType<typeof fakeStore>,
  release: CheckedRelease,
  fileName = release.package.fileName,
) {
  const zip = store.uploaded("1002");
  return zip && readZipEntry(zip, fileName);
}

/** The search terms and description someone gave the English listing of a draft. */
const EDITS = {
  keywords: ["iptv player", "m3u player", "xtream"],
  description: "Plays the IPTV you already pay for.",
};

/** A fake Store in which someone made a draft in Partner Center and edited its English listing. */
function drafted(options?: Parameters<typeof fakeStore>[0]) {
  const store = fakeStore(options);
  const id = store.draft();
  store.relist("en-us", EDITS);
  return { store, id };
}

/** The draft `id` as a run names it to submit, with the fingerprint a preflight reads from it. */
async function named(store: ReturnType<typeof fakeStore>, release: CheckedRelease, id: string) {
  const read = await preflight(store.access(), release, { id, metadataSha256: null });
  return { id, metadataSha256: read.draftMetadataSha256 };
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
    // Each language's listing as it was, screenshots and title included, but for the notes.
    expect(sentListings).toEqual(relisted(listings));
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
    const release = checked("0.0.5", { padding: 4 * 1024 * 1024 });

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

describe("listings titled from before the Store name", () => {
  const RETITLED = `the listing in en-us, nl-nl "${STORE_NAME}", as its package is named.`;

  it("take the name of a package that carries it, in every language, and change nothing else", async () => {
    const store = fakeStore({ title: "Mr. Streamer" });
    const { listings } = structuredClone(store.published());

    const outcome = await submit(store.access(), checked());

    expect(outcome).toMatchObject({
      stage: "in-progress",
      remarks: [`The submission retitles ${RETITLED}`],
    });
    expect(store.sent("PUT /submissions/1002")["listings"]).toEqual(relisted(listings, STORE_NAME));
  });

  it("keep their title with a package built before that name", async () => {
    const store = fakeStore({ title: "Mr. Streamer" });
    const { listings } = structuredClone(store.published());

    const outcome = await submit(store.access(), checked("0.0.5", { displayName: "Mr. Streamer" }));

    expect(outcome).toMatchObject({ stage: "in-progress", remarks: [] });
    expect(store.sent("PUT /submissions/1002")["listings"]).toEqual(relisted(listings));
  });

  it("are named by the preflight, which changes nothing", async () => {
    const store = fakeStore({ title: "Mr. Streamer" });

    const { found, problems } = await preflight(store.access(), checked());

    expect(problems).toEqual([]);
    expect(found.at(-1)).toBe(`The submission would retitle ${RETITLED}`);
    expect(store.writes()).toEqual([]);
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

describe("putting a release in a draft made in Partner Center", () => {
  it("fills the draft the run names and leaves the rest of it as its owner edited it", async () => {
    const { store, id } = drafted({ title: "Mr. Streamer" });
    const release = checked();
    const { applicationPackages: copied, listings, ...kept } = structuredClone(store.pending());

    const { found, problems, draftMetadataSha256 } = await preflight(store.access(), release, {
      id,
      metadataSha256: null,
    });

    expect(problems).toEqual([]);
    expect(draftMetadataSha256).toMatch(/^[0-9a-f]{64}$/);
    // The package's name in the draft: its own, then the draft and the start of the fingerprint.
    const fileName = release.package.fileName.replace(
      ".msix",
      `.draft-${id}.${draftMetadataSha256?.slice(0, 16)}.msix`,
    );
    // Which fields the owner edited, and never what they hold.
    expect(found.slice(5)).toEqual([
      `In progress: submission ${id}, PendingCommit.`,
      `Of what a release leaves alone, the draft ${id} differs from the published submission in 4 field(s): friendlyName, id, listings.en-us.baseListing.description, listings.en-us.baseListing.keywords.`,
      `Its fingerprint is ${draftMetadataSha256}, the SHA-256 of what a release leaves alone in it. A submit into the draft takes it.`,
      `0.0.5 would go in the draft ${id}, as ${fileName}.`,
      `The submission would retitle the listing in en-us, nl-nl "${STORE_NAME}", as its package is named.`,
    ]);
    expect(store.writes()).toEqual([]);

    const outcome = await submit(store.access(), release, {
      id,
      metadataSha256: draftMetadataSha256,
    });

    expect(outcome).toMatchObject({
      fileName,
      submissionId: id,
      status: "PreProcessing",
      stage: "in-progress",
    });
    expect(outcome.remarks.at(-1)).toContain(`It went into the draft ${id}`);
    // No new submission: the draft is updated, uploaded to and committed.
    expect(store.writes()).toEqual([
      `PUT /submissions/${id}`,
      "PUT block",
      "PUT blocklist",
      `POST /submissions/${id}/commit`,
    ]);
    const { applicationPackages, listings: sent, ...rest } = store.sent(`PUT /submissions/${id}`);
    expect(rest).toEqual(kept);
    expect(sent).toEqual(relisted(listings, STORE_NAME));
    expect(applicationPackages).toEqual([
      { ...copied[0], fileStatus: "PendingDelete" },
      {
        fileName,
        fileStatus: "PendingUpload",
        minimumDirectXVersion: "None",
        minimumSystemRam: "None",
      },
    ]);
    expect(store.pending()).toMatchObject({ listings: { "en-us": { baseListing: EDITS } } });
    const uploaded = uploadedPackage(store, release, fileName);
    expect(uploaded?.equals(readFileSync(release.package.path))).toBe(true);
  });

  it("reads one fingerprint whatever order Microsoft lists fields in, and another once a list is reordered", async () => {
    const { store, id } = drafted();
    const release = checked();
    const { metadataSha256 } = await named(store, release, id);

    const draft = store.pending();
    for (const field of Object.keys(draft).reverse()) {
      const value = draft[field];
      delete draft[field];
      draft[field] = value;
    }
    expect((await named(store, release, id)).metadataSha256).toBe(metadataSha256);

    store.relist("en-us", { keywords: EDITS.keywords.toReversed() });
    expect((await named(store, release, id)).metadataSha256).not.toBe(metadataSha256);
  });

  it.each<[string, (store: ReturnType<typeof fakeStore>) => string, string]>([
    ["no submission is in progress", () => "1002", "has no submission in progress"],
    [
      "another submission is in progress",
      (store) => `${store.draft()}9`,
      "Submission 1002 is in progress, not the draft 10029",
    ],
    [
      "Microsoft has the submission already, without the release",
      (store) => store.start("Certification", "Mr-Streamer-0.0.4-win-x64.msix", "1.0.4.0"),
      "is Certification, no longer a draft",
    ],
    [
      "the draft holds a package from elsewhere",
      (store) => store.start("PendingCommit", "Someone-Elses.msix"),
      "holds 1 package(s) that are neither the published submission's nor",
    ],
  ])("creates and changes nothing when %s", async (_, arrange, said) => {
    const store = fakeStore();
    const release = checked();
    const id = arrange(store);

    const read = await preflight(store.access(), release, { id, metadataSha256: null });
    const metadataSha256 = read.draftMetadataSha256 ?? "0".repeat(64);

    expect(read.problems).toEqual([expect.stringContaining(said)]);
    expect(await refusal(submit(store.access(), release, { id, metadataSha256 }))).toContain(said);
    expect(store.writes()).toEqual([]);
  });

  it.each([null, "", "f230699fecb4296d", "F".repeat(64)])(
    "asks nothing of Microsoft without the draft's fingerprint, as with %j",
    async (metadataSha256) => {
      const { store, id } = drafted();

      const message = await refusal(submit(store.access(), checked(), { id, metadataSha256 }));

      expect(message).toContain("that a preflight with the draft prints");
      expect(store.requests).toEqual([]);
    },
  );

  it("changes nothing in a draft that was edited after its fingerprint was read", async () => {
    const { store, id } = drafted();
    const release = checked();
    const draft = await named(store, release, id);
    store.relist("en-us", { keywords: ["iptv"] });

    const message = await refusal(submit(store.access(), release, draft));

    expect(message).toContain(`The draft ${id} doesn't have the fingerprint the run names`);
    expect((await preflight(store.access(), release, draft)).problems).toEqual([message]);
    expect(store.writes()).toEqual([]);
  });

  it("stops before the upload when Microsoft's update loses a field, and no run takes the draft up until it is back", async () => {
    const { store, id } = drafted();
    const release = checked();
    const draft = await named(store, release, id);
    store.rewriting("en-us", { keywords: [] });

    const message = await refusal(submit(store.access(), release, draft));

    // The field by its path, and nothing of what it held.
    expect(message).toContain(
      "differs from what the run found, in 1 field(s): listings.en-us.baseListing.keywords. Nothing was uploaded or committed.",
    );
    for (const keyword of EDITS.keywords) expect(message).not.toContain(keyword);
    expect(store.writes()).toEqual([`PUT /submissions/${id}`]);

    // The draft lists the package now. A plain submit stops at it, as a release's own run would.
    const stopped = store.requests.length;
    expect(await refusal(submit(store.access(), release))).toContain(
      "Only a run that names the draft and the same fingerprint goes on with it",
    );
    expect(await refusal(submit(store.access(), release, draft))).toContain(
      "doesn't have the fingerprint the run names",
    );
    // So does a run with the fingerprint a new preflight reads from what is left.
    const left = await named(store, release, id);
    expect(left.metadataSha256).not.toBe(draft.metadataSha256);
    expect(await refusal(submit(store.access(), release, left))).toContain(
      "which a run put there when the draft had another fingerprint",
    );
    expect(store.writes(stopped)).toEqual([]);

    // Once its owner put the search terms back, the first fingerprint fits again.
    store.relist("en-us", EDITS);
    expect(await submit(store.access(), release, draft)).toMatchObject({ stage: "in-progress" });
    expect(store.writes(stopped)).toEqual([
      "PUT block",
      "PUT blocklist",
      `POST /submissions/${id}/commit`,
    ]);
  });

  it.each<[string, Record<string, unknown>, string]>([
    [
      "a search term",
      { keywords: ["iptv"] },
      "differs from what the run found, in 1 field(s): listings.en-us.baseListing.keywords.",
    ],
    [
      "the title",
      { title: "Mr. Streamer" },
      "lacks what the release puts in it, in 1 field(s): listings.en-us.baseListing.title.",
    ],
  ])("commits nothing once %s changed while the package was uploaded", async (_, change, said) => {
    const { store, id } = drafted();
    const release = checked();
    const draft = await named(store, release, id);
    store.meanwhile("PUT blocklist", () => store.relist("en-us", change));

    const message = await refusal(submit(store.access(), release, draft));

    expect(message).toContain(`After the upload, `);
    expect(message).toContain(`${said} Nothing was committed.`);
    expect(store.writes()).toEqual([`PUT /submissions/${id}`, "PUT block", "PUT blocklist"]);
  });

  it("reports a draft someone committed while the package was uploaded, and commits nothing", async () => {
    const { store, id } = drafted();
    const release = checked();
    const draft = await named(store, release, id);
    store.meanwhile("PUT blocklist", () => store.advance("Certification"));

    const outcome = await submit(store.access(), release, draft);

    expect(outcome).toMatchObject({ submissionId: id, status: "Certification" });
    expect(outcome.remarks.at(-1)).toContain("This run committed nothing");
    expect(store.writes()).toEqual([`PUT /submissions/${id}`, "PUT block", "PUT blocklist"]);
  });

  it("commits only a draft that kept the release's What's new, whatever its line endings", async () => {
    const { store, id } = drafted();
    const release = checked();
    const draft = await named(store, release, id);
    store.rewriting("en-us", { releaseNotes: "What 0.0.4 changed." });

    expect(await refusal(submit(store.access(), release, draft))).toContain(
      "lacks what the release puts in it, in 1 field(s): listings.en-us.baseListing.releaseNotes",
    );
    expect(store.writes()).toEqual([`PUT /submissions/${id}`]);

    store.rewriting("en-us", { releaseNotes: WHATS_NEW.replaceAll("\n", "\r\n") });
    const outcome = await submit(store.access(), release, draft);

    expect(outcome).toMatchObject({ submissionId: id, stage: "in-progress" });
    // Updated again, with the package it listed already listed once.
    expect(store.pending().applicationPackages.map((file) => file["fileName"])).toEqual([
      "Mr-Streamer-0.0.4-win-x64.msix",
      outcome.fileName,
    ]);
  });

  it("goes on with a draft an interrupted run filled, on the same fingerprint and without another update", async () => {
    const { store, id } = drafted();
    const release = checked();
    const draft = await named(store, release, id);
    store.fail("PUT block", 403, "AuthenticationFailed");

    expect(await refusal(submit(store.access(), release, draft))).toContain(
      `with submit, the draft ${id} and the same fingerprint`,
    );
    const interrupted = store.requests.length;
    // The draft lists the package, and still a run that doesn't name it sends nothing.
    expect(await refusal(submit(store.access(), release))).toContain(
      `Submission ${id} is in progress (PendingCommit) and holds 0.0.5's package`,
    );
    expect((await preflight(store.access(), release, draft)).found.at(-1)).toBe(
      `0.0.5 would be committed in the draft ${id}, which holds it.`,
    );
    expect(store.writes(interrupted)).toEqual([]);
    const outcome = await submit(store.access(), release, draft);

    expect(outcome).toMatchObject({ submissionId: id, stage: "in-progress" });
    expect(store.writes(interrupted)).toEqual([
      "PUT block",
      "PUT blocklist",
      `POST /submissions/${id}/commit`,
    ]);

    // Once Microsoft has it, the same run reports where it stands.
    store.advance("Certification");
    const committed = store.requests.length;
    expect(await submit(store.access(), release, draft)).toMatchObject({
      submissionId: id,
      status: "Certification",
      stage: "in-progress",
    });
    expect(store.writes(committed)).toEqual([]);
  });

  it("says what Microsoft answered when it refuses the update, and never to delete the draft", async () => {
    const { store, id } = drafted();
    const release = checked();
    const draft = await named(store, release, id);
    const before = structuredClone(store.pending());
    store.fail(
      `PUT /submissions/${id}`,
      409,
      JSON.stringify({ code: "InvalidOperation", message: "It was changed in Partner Center." }),
    );

    const message = await refusal(submit(store.access(), release, draft));

    expect(message).toContain(
      `Microsoft answered HTTP 409 to adding the package to submission ${id}`,
    );
    expect(message).toContain(
      "Microsoft says: InvalidOperation: It was changed in Partner Center.",
    );
    expect(message).toContain("Nothing was uploaded or committed.");
    expect(message).not.toMatch(/delet/i);
    expect(store.pending()).toEqual(before);
  });

  it("stays untouched by a run that doesn't name it", async () => {
    const { store, id } = drafted();

    expect(await refusal(submit(store.access(), checked()))).toContain(
      `Submission ${id} is in progress (PendingCommit) and doesn't hold`,
    );
    expect(store.writes()).toEqual([]);
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

  it("follows a release that went into a draft a run named, by its name there", async () => {
    const { store, id } = drafted();
    const release = checked();
    const { fileName } = await submit(store.access(), release, await named(store, release, id));
    expect(fileName).toContain(`.draft-${id}.`);

    store.advance("Certification");
    expect(await status(store.access(), released())).toMatchObject({
      fileName,
      submissionId: id,
      stage: "in-progress",
      remarks: [],
    });
    store.advance("Published");
    expect(await status(store.access(), released())).toMatchObject({
      fileName,
      submissionId: id,
      stage: "live",
      remarks: [],
    });
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
      "Listings: en-us with 2 image(s), nl-nl with 1 image(s). Trailers: 1.",
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
