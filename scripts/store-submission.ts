// The Microsoft side of a Store submission, through Microsoft's Store submission API: what the
// Store holds, sending a checked package, and reading what Microsoft did with it.
// scripts/store-release.ts is the GitHub side; docs/maintainers/microsoft-store.md describes both.
//
//   node scripts/store-submission.ts preflight [--release <file>]
//   node scripts/store-submission.ts submit --release <file>
//   node scripts/store-submission.ts status --release <file>
//
// The credential comes from the environment: STORE_TENANT_ID, STORE_CLIENT_ID and
// STORE_CLIENT_SECRET, with STORE_CLIENT_SECRET_EXPIRES for the day the key ends.
//
// preflight and status only read. submit follows these rules:
//
// - A new submission is Microsoft's copy of the published one. It goes back as it came, fields
//   this script doesn't know included, with two changes: the package, and "What's new". The
//   description, screenshots, trailers, price and markets stay as they are.
// - A listing has to carry its package's name. With a package named STORE_NAME, every listing
//   titled otherwise gets that name as its title, which happens once. A package built before
//   that name changes no title.
// - It never sets who sees the app or when it is published. The published submission must be
//   Public and publish as soon as it is certified (Immediate), or nothing is created.
// - A package is uploaded under a name that carries the release's commit and the file's checksum.
//   That name is how a later run finds its own submission, so repeating a run adds nothing.
// - The Store takes one submission at a time. One that doesn't hold this release's package stops
//   the run, whoever made it, and so does a published package this one doesn't sort after.
//   Nothing is ever deleted, and a submission Microsoft is checking is never changed.
// - Only requests that change nothing by being repeated are sent again. When creating or
//   committing gets no clear answer, the script reads what happened instead of asking twice.
// - Nothing of a token, the key or an upload address is printed, and of Microsoft's answers only
//   what this script knows the shape of.
//
// The Store job runs it with plain node and installs no packages, so it imports only node: modules
// and dependency-free files, by relative path.
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { comparePackageVersions } from "../packages/contracts/src/package-version.ts";
import {
  isRecord,
  readStoreRelease,
  STORE_APP,
  STORE_ENVIRONMENT,
  STORE_NAME,
  storeFilePrefix,
  type StorePackage,
  type StoreRelease,
} from "./store-release.ts";
import { storedZip } from "./zip.ts";

const LOGIN = "https://login.microsoftonline.com";
const API = "https://manage.devcenter.microsoft.com";
const APP = `${API}/v1.0/my/applications/${STORE_APP.id}`;

/** How often a request that changes nothing by being repeated is sent before giving up. */
const ATTEMPTS = 3;
const REQUEST_MS = 120_000;
/** Azure takes a file in blocks, and 4 MiB fits every version of its API. */
const BLOCK_BYTES = 4 * 1024 * 1024;
/** After a commit Microsoft checks the upload: asked every 15 seconds, for ten minutes at most. */
const COMMIT_POLL_MS = 15_000;
const COMMIT_POLLS = 40;
/** The Store's "What's new in this version" takes 1500 characters. */
const NOTES_MAX = 1500;
/** The key's end is worth a warning this long before it comes. */
const EXPIRY_WARNING_MS = 30 * 24 * 60 * 60 * 1000;

/** Statuses in which Microsoft is working on a submission, or it waits to be published. */
const WORKING = [
  "CommitStarted",
  "PreProcessing",
  "Certification",
  "Release",
  "Publishing",
  "PendingPublication",
];

const RECOVER = "run the Microsoft Store workflow with submit";

/** What to do about a new submission that got no package: only a person may delete one. */
const leftover = (id: string) =>
  `Submission ${id} is left as an untouched copy of the published one: delete it in Partner Center, then ${RECOVER}.`;

/** The network: `fetch`, or a test's stand-in for Microsoft. */
export type Send = (
  url: string,
  request: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body?: string | Uint8Array;
    readonly signal: AbortSignal;
  },
) => Promise<Response>;

/** Who signs in, and how the script reaches Microsoft. */
export interface StoreAccess {
  readonly tenantId: string;
  readonly clientId: string;
  /** The application's key. */
  readonly clientSecret: string;
  readonly send: Send;
  /** Waits between attempts and between polls. */
  readonly wait: (ms: number) => Promise<void>;
}

/** A release whose package `verify` has checked. */
export type CheckedRelease = StoreRelease & { readonly package: StorePackage };

/** What a submission means for a release. Only "live" says Store users get it. */
export type Stage = "live" | "in-progress" | "draft" | "failed" | "absent";

/** Where a release stands in the Store, each part reported on its own. */
export interface Outcome {
  /** The GitHub release. */
  readonly version: string;
  readonly commit: string;
  /** The package version the Store reads. */
  readonly packageVersion: string;
  /** The package's name in the Store. Null when the Store has none of this release. */
  readonly fileName: string | null;
  readonly submissionId: string | null;
  /** Microsoft's own word for where the submission stands. */
  readonly status: string | null;
  readonly stage: Stage;
  /** Microsoft's errors and warnings, and what this script adds. */
  readonly remarks: readonly string[];
}

export interface Preflight {
  /** What the account and the Store hold. */
  readonly found: readonly string[];
  /** What would stop a submission. Empty when one could go ahead. */
  readonly problems: readonly string[];
}

/** A refusal or failure to show as it is: its message holds nothing secret. */
export class StoreError extends Error {}

/** What Microsoft answered. */
interface Answer {
  readonly status: number;
  /** The body as JSON; undefined when it wasn't JSON. */
  readonly body: unknown;
  /** Microsoft's ID for the request, which its support asks for. */
  readonly correlation: string | null;
}

interface Session {
  readonly access: StoreAccess;
  readonly token: string;
  /** Makes Microsoft's text safe to print. */
  readonly clean: (text: string) => string;
}

interface SubmittedPackage {
  readonly fileName: string;
  /** PendingUpload, Uploaded or PendingDelete. */
  readonly fileStatus: string;
  /** Empty until Microsoft has read the file. */
  readonly version: string;
}

/** What this script reads from a submission. */
interface Submission {
  readonly id: string;
  readonly status: string;
  readonly visibility: string;
  readonly publishMode: string;
  readonly packages: readonly SubmittedPackage[];
  /** Where its files are uploaded. Secret: whoever has it can write there. */
  readonly uploadUrl: string | null;
  /** Microsoft's errors and warnings about it, safe to print. */
  readonly remarks: readonly string[];
  /** All of it, as Microsoft sent it. */
  readonly raw: Record<string, unknown>;
}

interface StoreState {
  /** What the Store offers now. */
  readonly published: Submission;
  /** The submission in progress: a draft, one Microsoft is checking, or one it refused. */
  readonly pending: Submission | null;
}

type Step =
  /** The release is in the Store's hands already. */
  | { readonly take: "report"; readonly submission: Submission; readonly live: boolean }
  /** An earlier run's draft holds the package and was never committed. */
  | { readonly take: "resume"; readonly draft: Submission }
  /** A new submission. `renamed` lists the languages whose listing takes the package's name. */
  | { readonly take: "create"; readonly renamed: readonly string[] };

/**
 * Says what the account holds and, given a release, what `submit` would do with it. Reads only.
 */
export async function preflight(
  access: StoreAccess,
  release: CheckedRelease | null,
): Promise<Preflight> {
  const session = await signIn(access);
  const state = await storeState(session);
  const { published, pending } = state;
  const found = [
    `Signed in. Application ${STORE_APP.id} is ${STORE_APP.identityName}.`,
    `Published: submission ${published.id}, ${published.visibility || "no audience"}, publishing ${published.publishMode || "unset"}.`,
    ...published.packages.map((file) => `Package ${file.fileName}: ${file.version || "unread"}.`),
    ...listingFacts(published, session.clean),
    pending
      ? `In progress: submission ${pending.id}, ${pending.status}. A release waits until it is finished.`
      : "No submission in progress.",
  ];
  const problems = new Set<string>();
  const attempt = (check: () => void) => {
    try {
      check();
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
      problems.add(error.message);
    }
  };
  attempt(() => assertPublic(published, "The published submission"));
  if (release) {
    attempt(() => {
      const step = nextStep(state, release);
      found.push(
        step.take === "create"
          ? `${release.version} would go in a new submission, as ${release.package.fileName}.`
          : step.take === "resume"
            ? `${release.version} would be committed in the draft ${step.draft.id}, which holds it.`
            : `${release.version} is in submission ${step.submission.id} already: nothing would be sent.`,
      );
      if (step.take === "create") {
        found.push(...retitling(step.renamed, "would retitle", session.clean));
      }
    });
  }
  return { found, problems: [...problems] };
}

/**
 * Sends `release`'s package to the Store, unless the Store has it: then it reports where that
 * submission stands and changes nothing. Returns once Microsoft took or refused the commit, which
 * is long before certification ends. Throws a StoreError when the submission is refused here.
 */
export async function submit(access: StoreAccess, release: CheckedRelease): Promise<Outcome> {
  const session = await signIn(access);
  const step = nextStep(await storeState(session), release);
  if (step.take === "report") {
    const { submission } = step;
    return {
      ...subject(release),
      fileName: release.package.fileName,
      submissionId: submission.id,
      status: submission.status,
      stage: step.live ? "live" : stageOf(submission.status),
      remarks: submission.remarks,
    };
  }
  const draft =
    step.take === "resume" ? step.draft : await fill(session, await create(session), release);
  await upload(session, draft, release);
  const committed = await commit(session, draft.id);
  return {
    ...subject(release),
    fileName: release.package.fileName,
    submissionId: draft.id,
    status: committed.status,
    stage: stageOf(committed.status),
    remarks: [
      ...committed.remarks,
      ...(step.take === "create" ? retitling(step.renamed, "retitles", session.clean) : []),
    ],
  };
}

/**
 * Where `release` stands in the Store: by the name this automation gives its packages, or else by
 * the package version, which finds a package someone uploaded in Partner Center. Reads only.
 */
export async function status(access: StoreAccess, release: StoreRelease): Promise<Outcome> {
  const session = await signIn(access);
  const { published, pending } = await storeState(session);
  const prefix = storeFilePrefix(release);
  const named = (file: SubmittedPackage) => file.fileName.startsWith(prefix);
  const numbered = (file: SubmittedPackage) => file.version === release.packageVersion;
  for (const mine of [named, numbered]) {
    for (const submission of [published, pending]) {
      const file = submission && held(submission, mine);
      if (!file) continue;
      return {
        ...subject(release),
        fileName: file.fileName,
        submissionId: submission.id,
        status: submission.status,
        stage: submission === published ? "live" : stageOf(submission.status),
        remarks: [
          ...submission.remarks,
          ...(mine === named
            ? []
            : [
                `The Store lists it as ${file.fileName}, a name this automation doesn't give: it was uploaded another way, and only its version ties it to the release.`,
              ]),
        ],
      };
    }
  }
  const offered = published.packages.map((file) => file.version || file.fileName).join(", ");
  return {
    ...subject(release),
    fileName: null,
    submissionId: null,
    status: null,
    stage: "absent",
    remarks: [
      `The Store offers ${offered || "no package"}, from submission ${published.id}.`,
      ...(pending
        ? [`Submission ${pending.id} is in progress (${pending.status}), with other packages.`]
        : []),
    ],
  };
}

/**
 * The Store's "What's new" for a release: the titles its GitHub notes list, oldest first, without
 * authors and links, as many as fit. The Store shows plain text.
 */
export function storeNotes(release: Pick<StoreRelease, "version" | "notes">): string {
  let notes = "";
  for (const [, title] of release.notes.matchAll(/^\* (.+) by @\S+ in \S+$/gm)) {
    const next = `${notes}${notes ? "\n" : ""}- ${title}`;
    if (next.length > NOTES_MAX) break;
    notes = next;
  }
  return notes || `Mr. Streamer ${release.version}.`;
}

/**
 * What to say about the day the key ends, `expires` as YYYY-MM-DD: nothing while it is more than
 * 30 days away.
 */
export function keyExpiry(expires: string | undefined, now: number): string | null {
  const renew = "docs/maintainers/microsoft-store.md#renewing-the-key says how to renew it.";
  const end = /^\d{4}-\d{2}-\d{2}$/.test(expires ?? "") ? Date.parse(`${expires}T00:00:00Z`) : NaN;
  if (Number.isNaN(end)) {
    return `No day is recorded for the end of the Store key, in the variable STORE_CLIENT_SECRET_EXPIRES. ${renew}`;
  }
  if (end <= now) return `The Store key ended on ${expires}, by the recorded date. ${renew}`;
  if (end - now > EXPIRY_WARNING_MS) return null;
  return `The Store key ends on ${expires}, in ${Math.ceil((end - now) / 86_400_000)} days. ${renew}`;
}

function subject(release: StoreRelease) {
  return {
    version: release.version,
    commit: release.commit,
    packageVersion: release.packageVersion,
  };
}

function stageOf(status: string): Stage {
  if (status === "Published") return "live";
  if (status === "PendingCommit") return "draft";
  // Everything else is a refusal or a stop: the Failed statuses, Canceled, and any word Microsoft
  // adds later, which is safer read as a failure than as progress.
  return WORKING.includes(status) ? "in-progress" : "failed";
}

/**
 * The languages whose listing takes the Store name as its title when `release` goes into
 * `submission`. A listing has to carry its package's name: one titled otherwise changes when the
 * package is named STORE_NAME. A package built before that name changes none.
 */
function retitled(submission: Submission, release: CheckedRelease): string[] {
  const { listings } = submission.raw;
  if (release.package.displayName !== STORE_NAME || !isRecord(listings)) return [];
  return Object.entries(listings).flatMap(([language, listing]) =>
    isRecord(listing) &&
    isRecord(listing["baseListing"]) &&
    listing["baseListing"]["title"] !== STORE_NAME
      ? [language]
      : [],
  );
}

/**
 * What to say about a submission that gives the listings in `languages` the Store name: it
 * "retitles" them once it is made, and "would retitle" them before. Nothing when none changes.
 */
function retitling(
  languages: readonly string[],
  verb: "retitles" | "would retitle",
  clean: Session["clean"],
): string[] {
  if (languages.length === 0) return [];
  return [
    `The submission ${verb} the listing in ${languages.map(clean).join(", ")} "${STORE_NAME}", as its package is named.`,
  ];
}

/** The package of `submission` that `mine` recognises, unless it is on its way out. */
function held(
  submission: Submission,
  mine: (file: SubmittedPackage) => boolean,
): SubmittedPackage | undefined {
  return submission.packages.find((file) => file.fileStatus !== "PendingDelete" && mine(file));
}

/**
 * What `submit` does next for `release`. Throws when the Store's state refuses a submission:
 * another one is in progress, a published package isn't older, or the listing isn't Public and
 * Immediate.
 */
function nextStep(state: StoreState, release: CheckedRelease): Step {
  const { published, pending } = state;
  const mine = (file: SubmittedPackage) => file.fileName === release.package.fileName;
  if (held(published, mine)) return { take: "report", submission: published, live: true };
  for (const file of published.packages) {
    let newer: boolean;
    try {
      newer = comparePackageVersions(release.packageVersion, file.version) > 0;
    } catch {
      throw new StoreError(
        `Microsoft lists the published package ${file.fileName} with the version "${file.version}", which can't be compared with ${release.packageVersion}.`,
      );
    }
    if (!newer) {
      throw new StoreError(
        `The Store offers package ${file.version} already, as ${file.fileName}. ${release.packageVersion} doesn't sort after it, so ${release.version} isn't submitted.`,
      );
    }
  }
  if (!pending) {
    assertPublic(published, "The published submission");
    return { take: "create", renamed: retitled(published, release) };
  }
  if (!held(pending, mine)) {
    throw new StoreError(
      `Submission ${pending.id} is in progress (${pending.status}) and doesn't hold ${release.package.fileName}. The Store takes one submission at a time: let it finish, or delete it in Partner Center if nobody needs it, then ${RECOVER}. This script deletes nothing.`,
    );
  }
  if (pending.status !== "PendingCommit") {
    return { take: "report", submission: pending, live: false };
  }
  assertPublic(pending, "The draft");
  return { take: "resume", draft: pending };
}

/**
 * Throws unless `submission` is for everyone and published as soon as it is certified. `then` says
 * what is left to do when it isn't.
 */
function assertPublic(submission: Submission, what: string, then = ""): void {
  if (submission.visibility === "Public" && submission.publishMode === "Immediate") return;
  throw new StoreError(
    `${what}, ${submission.id}, has the audience "${submission.visibility}" and the publishing mode "${submission.publishMode}". This automation only updates a Public listing that publishes as soon as it is certified (Immediate), and sets neither itself. Nothing was committed. ${then}`.trim(),
  );
}

/** A new submission: Microsoft's copy of the published one. */
async function create(session: Session): Promise<Submission> {
  const answer = await call(session, "POST", "/submissions");
  const created = answer && answer.status >= 200 && answer.status < 300;
  const draft = created ? submissionOf(answer.body, session.clean) : null;
  if (draft) {
    assertPublic(draft, "The new submission", leftover(draft.id));
    return draft;
  }
  const unclear =
    !answer || created || answer.status >= 500 || answer.status === 408 || answer.status === 429;
  if (!unclear) throw refusal("creating a submission", answer, session.clean);
  // The submission may exist all the same. A second request couldn't make another, since the
  // Store takes one at a time, but nothing would show that the one there is this run's.
  const { pendingId } = await storeApp(session);
  throw new StoreError(
    pendingId
      ? `Microsoft gave no clear answer to creating a submission, and submission ${pendingId} is in progress now. Nothing shows whether this run made it. Look at it in Partner Center: when it is an untouched copy nobody is working on, delete it there, then ${RECOVER}.`
      : `Microsoft gave no clear answer to creating a submission, and the app has none in progress. To try again, ${RECOVER}.`,
  );
}

/**
 * Puts the package, "What's new" and, where `retitled` names a listing, the Store name into `draft`
 * and sends the rest back as it came. The packages it copied are marked for removal: the Store
 * offers the newest one to everyone they served.
 */
async function fill(
  session: Session,
  draft: Submission,
  release: CheckedRelease,
): Promise<Submission> {
  const { fileName } = release.package;
  const copied = Array.isArray(draft.raw["applicationPackages"])
    ? draft.raw["applicationPackages"]
    : [];
  const listings = draft.raw["listings"];
  const notes = storeNotes(release);
  const renamed = retitled(draft, release);
  const body = {
    ...draft.raw,
    applicationPackages: [
      ...copied.map((file: unknown) =>
        isRecord(file) ? { ...file, fileStatus: "PendingDelete" } : file,
      ),
      // What Microsoft asks of a new package; the rest it reads from the file.
      {
        fileName,
        fileStatus: "PendingUpload",
        minimumDirectXVersion: "None",
        minimumSystemRam: "None",
      },
    ],
    listings: isRecord(listings)
      ? Object.fromEntries(
          Object.entries(listings).map(([language, listing]) => [
            language,
            isRecord(listing) && isRecord(listing["baseListing"])
              ? {
                  ...listing,
                  baseListing: {
                    ...listing["baseListing"],
                    releaseNotes: notes,
                    ...(renamed.includes(language) && { title: STORE_NAME }),
                  },
                }
              : listing,
          ]),
        )
      : listings,
  };
  const answer = await call(session, "PUT", `/submissions/${draft.id}`, body);
  if (!answer || answer.status < 200 || answer.status >= 300) {
    const { message } = refusal(
      `adding the package to submission ${draft.id}`,
      answer,
      session.clean,
    );
    throw new StoreError(`${message} ${leftover(draft.id)}`);
  }
  const filled = submissionOf(answer.body, session.clean);
  if (!filled || !held(filled, (file) => file.fileName === fileName)) {
    throw new StoreError(
      `Microsoft took the update without listing ${fileName}. ${leftover(draft.id)}`,
    );
  }
  return { ...filled, uploadUrl: filled.uploadUrl ?? draft.uploadUrl };
}

/**
 * Uploads the package, in the ZIP the API takes files in, to the address Microsoft gave for
 * `draft`. Sending a block or the list of blocks twice changes nothing, so each is repeated when
 * it fails.
 */
async function upload(session: Session, draft: Submission, release: CheckedRelease): Promise<void> {
  const url = draft.uploadUrl;
  if (!url || !/^https:\/\/[^/?#]+\/[^?#]*\?[^#]+$/.test(url)) {
    throw new StoreError(`Microsoft gave no upload address for submission ${draft.id}.`);
  }
  const file = readFileSync(release.package.path);
  if (createHash("sha256").update(file).digest("hex") !== release.package.sha256) {
    throw new StoreError("The package on disk is no longer the one that was checked.");
  }
  const archive = storedZip(release.package.fileName, file);
  const put = async (query: string, body: string | Uint8Array) => {
    const answer = await request(
      session.access,
      `${url}&${query}`,
      { method: "PUT", headers: {}, body },
      true,
    );
    if (answer && answer.status >= 200 && answer.status < 300) return;
    throw new StoreError(
      `Uploading the package for submission ${draft.id} ${answer ? `was refused with HTTP ${answer.status}` : "got no answer"}. The submission is a draft that holds ${release.package.fileName} by name: to upload and commit it, ${RECOVER}.`,
    );
  };
  const blocks: string[] = [];
  for (let start = 0; start < archive.length; start += BLOCK_BYTES) {
    const id = Buffer.from(`block-${String(blocks.length).padStart(6, "0")}`).toString("base64");
    blocks.push(id);
    await put(
      `comp=block&blockid=${encodeURIComponent(id)}`,
      archive.subarray(start, start + BLOCK_BYTES),
    );
  }
  const list = blocks.map((id) => `<Latest>${id}</Latest>`).join("");
  await put(
    "comp=blocklist",
    `<?xml version="1.0" encoding="utf-8"?><BlockList>${list}</BlockList>`,
  );
}

/**
 * Commits the draft `id` and waits, for ten minutes at most, until Microsoft has taken or refused
 * it. When the commit gets no clear answer, the submission's status says whether it went through.
 */
async function commit(
  session: Session,
  id: string,
): Promise<Pick<Submission, "status" | "remarks">> {
  const answer = await call(session, "POST", `/submissions/${id}/commit`);
  const accepted = answer !== null && answer.status >= 200 && answer.status < 300;
  let current = await statusOf(session, id);
  if (!accepted && current.status === "PendingCommit") {
    const { message } = refusal(`committing submission ${id}`, answer, session.clean);
    throw new StoreError(
      `${message} It is still a draft that holds this release's package: to commit it, ${RECOVER}.`,
    );
  }
  const waiting = () =>
    current.status === "CommitStarted" || (accepted && current.status === "PendingCommit");
  for (let poll = 0; waiting() && poll < COMMIT_POLLS; poll++) {
    await session.access.wait(COMMIT_POLL_MS);
    current = await statusOf(session, id);
  }
  return current;
}

async function statusOf(
  session: Session,
  id: string,
): Promise<Pick<Submission, "status" | "remarks">> {
  const what = `reading the status of submission ${id}`;
  const answer = await call(session, "GET", `/submissions/${id}/status`);
  if (!answer || answer.status !== 200) throw refusal(what, answer, session.clean);
  const body = answer.body;
  if (!isRecord(body) || typeof body["status"] !== "string") {
    throw new StoreError(`Microsoft answered ${what} with nothing readable.`);
  }
  return { status: body["status"], remarks: remarksOf(body["statusDetails"], session.clean) };
}

/** The app's published submission and the one in progress, once the app is shown to be ours. */
async function storeState(session: Session): Promise<StoreState> {
  const { publishedId, pendingId } = await storeApp(session);
  const read = async (id: string) => {
    const what = `reading submission ${id}`;
    const answer = await call(session, "GET", `/submissions/${id}`);
    if (!answer || answer.status !== 200) throw refusal(what, answer, session.clean);
    const submission = submissionOf(answer.body, session.clean);
    if (!submission) throw new StoreError(`Microsoft answered ${what} with nothing readable.`);
    return submission;
  };
  return { published: await read(publishedId), pending: pendingId ? await read(pendingId) : null };
}

/** The IDs of the app's submissions. Throws unless the application ID is Mr. Streamer's package. */
async function storeApp(
  session: Session,
): Promise<{ readonly publishedId: string; readonly pendingId: string | null }> {
  const answer = await call(session, "GET", "");
  if (!answer || answer.status !== 200) throw refusal("reading the app", answer, session.clean);
  const app = isRecord(answer.body) ? answer.body : {};
  const { packageIdentityName: name, publisherName: publisher } = app;
  if (name !== STORE_APP.identityName || publisher !== STORE_APP.publisher) {
    throw new StoreError(
      `Application ${STORE_APP.id} isn't ${STORE_APP.identityName} by ${STORE_APP.publisher} in this account, so nothing is sent to it. Microsoft names it ${session.clean(String(name))} by ${session.clean(String(publisher))}.`,
    );
  }
  const idOf = (key: string) => {
    const named = app[key];
    return isRecord(named) && isId(named["id"]) ? named["id"] : null;
  };
  const publishedId = idOf("lastPublishedApplicationSubmission");
  if (!publishedId) {
    throw new StoreError(
      "The app has no published submission. The API copies the published one, so the first goes through Partner Center.",
    );
  }
  return { publishedId, pendingId: idOf("pendingApplicationSubmission") };
}

/** Whether `value` is a submission's ID, which goes into the address of later requests. */
function isId(value: unknown): value is string {
  return typeof value === "string" && /^[\w-]{1,64}$/.test(value);
}

/** The submission in one of Microsoft's answers, or null when this script can't read one there. */
function submissionOf(body: unknown, clean: Session["clean"]): Submission | null {
  if (!isRecord(body) || !isId(body["id"]) || typeof body["status"] !== "string") return null;
  const text = (from: Record<string, unknown>, key: string) => {
    const value = from[key];
    return typeof value === "string" ? value : "";
  };
  const packages = Array.isArray(body["applicationPackages"]) ? body["applicationPackages"] : [];
  return {
    id: body["id"],
    status: body["status"],
    visibility: text(body, "visibility"),
    publishMode: text(body, "targetPublishMode"),
    packages: packages.filter(isRecord).map((file) => ({
      fileName: text(file, "fileName"),
      fileStatus: text(file, "fileStatus"),
      version: text(file, "version"),
    })),
    uploadUrl: text(body, "fileUploadUrl") || null,
    remarks: remarksOf(body["statusDetails"], clean),
    raw: body,
  };
}

/** Microsoft's errors and warnings about a submission. Its reports are counted: they are links. */
function remarksOf(details: unknown, clean: Session["clean"]): string[] {
  if (!isRecord(details)) return [];
  const listed = (key: string, label: string) =>
    (Array.isArray(details[key]) ? details[key] : []).filter(isRecord).map((each) => {
      const parts = [each["code"], each["details"]].filter((part) => typeof part === "string");
      return `${label}: ${clean(parts.join(": "))}`;
    });
  const reports = Array.isArray(details["certificationReports"])
    ? details["certificationReports"].length
    : 0;
  return [
    ...listed("errors", "Error"),
    ...listed("warnings", "Warning"),
    ...(reports > 0 ? [`Partner Center holds ${reports} certification report(s).`] : []),
  ].slice(0, 20);
}

/** What a copy of `submission` would carry over, for a person to check against the listing. */
function listingFacts(submission: Submission, clean: Session["clean"]): string[] {
  const { listings, trailers, pricing } = submission.raw;
  const languages = Object.entries(isRecord(listings) ? listings : {}).map(
    ([language, listing]) => {
      const base =
        isRecord(listing) && isRecord(listing["baseListing"]) ? listing["baseListing"] : {};
      const images = Array.isArray(base["images"]) ? base["images"].length : 0;
      return `${clean(language)} with ${images} image(s)`;
    },
  );
  const price =
    isRecord(pricing) && typeof pricing["priceId"] === "string" ? pricing["priceId"] : "";
  return [
    `Listings: ${languages.join(", ") || "none"}. Trailers: ${Array.isArray(trailers) ? trailers.length : 0}.`,
    `Price: ${clean(price) || "unread"}.`,
  ];
}

/** Signs in as the application. The token lasts an hour, longer than any run of this script. */
async function signIn(access: StoreAccess): Promise<Session> {
  const id = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  if (!id.test(access.tenantId)) throw new StoreError("STORE_TENANT_ID is not a tenant ID.");
  if (!id.test(access.clientId)) throw new StoreError("STORE_CLIENT_ID is not a client ID.");
  const answer = await request(
    access,
    `${LOGIN}/${access.tenantId}/oauth2/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: access.clientId,
        client_secret: access.clientSecret,
        resource: API,
      }).toString(),
    },
    // Asking for a token twice changes nothing.
    true,
  );
  const body = answer && isRecord(answer.body) ? answer.body : {};
  const token = body["access_token"];
  if (answer?.status === 200 && typeof token === "string" && token) {
    return { access, token, clean: cleaner([access.clientSecret, token]) };
  }
  if (!answer) throw new StoreError("Microsoft Entra didn't answer the sign-in.");
  const error = typeof body["error"] === "string" ? body["error"] : "";
  const code = /AADSTS\d+/.exec(String(body["error_description"]))?.[0];
  const named = [/^\w{1,40}$/.test(error) ? error : `HTTP ${answer.status}`, code].filter(Boolean);
  throw new StoreError(
    `Microsoft Entra refused the sign-in (${named.join(", ")}). ${(code && SIGN_IN_HINTS[code]) ?? "Check the tenant ID, the client ID and the key in the microsoft-store environment."}`,
  );
}

/** What Entra's commonest refusals mean here. */
const SIGN_IN_HINTS: Record<string, string> = {
  AADSTS7000215:
    "The key is wrong. The secret must hold the key's value, which Partner Center shows once.",
  AADSTS7000222:
    "The key has ended. docs/maintainers/microsoft-store.md#renewing-the-key says how to make a new one.",
  AADSTS700016: "The tenant has no application with that client ID.",
  AADSTS90002: "There is no tenant with that ID.",
};

/** Calls the submission API for the app. GET and PUT are repeated when they fail, POST never. */
function call(
  session: Session,
  method: "GET" | "PUT" | "POST",
  path: string,
  body?: unknown,
): Promise<Answer | null> {
  return request(
    session.access,
    `${APP}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${session.token}`,
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    },
    method !== "POST",
  );
}

/**
 * Sends a request and reads the answer. Null when none came. With `repeat`, it is sent again
 * after no answer or one that says to try later, up to three times in all.
 */
async function request(
  access: StoreAccess,
  url: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body?: string | Uint8Array;
  },
  repeat: boolean,
): Promise<Answer | null> {
  for (let attempt = 1; ; attempt++) {
    let answer: Answer | null = null;
    try {
      const response = await access.send(url, { ...init, signal: AbortSignal.timeout(REQUEST_MS) });
      const text = await response.text();
      const correlation = response.headers.get("MS-CorrelationId");
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      answer = {
        status: response.status,
        body,
        correlation: correlation && /^[\w-]{1,64}$/.test(correlation) ? correlation : null,
      };
    } catch {
      // No answer: the error could name the address, so it isn't kept.
    }
    const later = !answer || answer.status >= 500 || answer.status === 408 || answer.status === 429;
    if (!repeat || !later || attempt >= ATTEMPTS) return answer;
    await access.wait(attempt * 2000);
  }
}

/** What to say when Microsoft refused or didn't answer, with what its documented answers mean. */
function refusal(what: string, answer: Answer | null, clean: Session["clean"]): StoreError {
  if (!answer) return new StoreError(`Microsoft didn't answer ${what}.`);
  const hints: Record<number, string> = {
    401: "The sign-in was refused.",
    403: "The application lacks the Manager role in Partner Center.",
    404: "Microsoft finds no such app or submission in this account.",
    409: "The app's state doesn't allow it, or the app uses a Partner Center feature the API doesn't support.",
    429: "Microsoft asks for fewer requests.",
  };
  // Microsoft's own errors name a code and a message. Any other body stays unprinted.
  const { body } = answer;
  const said =
    isRecord(body) && typeof body["code"] === "string" && typeof body["message"] === "string"
      ? `Microsoft says: ${clean(`${body["code"]}: ${body["message"]}`)}`
      : "";
  const asked = answer.correlation ? `Request ${answer.correlation}.` : "";
  return new StoreError(
    [`Microsoft answered HTTP ${answer.status} to ${what}.`, hints[answer.status], said, asked]
      .filter(Boolean)
      .join(" "),
  );
}

/**
 * Makes text from Microsoft safe to print: without `secrets`, addresses, which can carry an upload
 * signature, and anything shaped like a token, on one line and no longer than 400 characters.
 */
function cleaner(secrets: readonly string[]): (text: string) => string {
  return (text) =>
    secrets
      .filter(Boolean)
      .reduce((cleaned, secret) => cleaned.replaceAll(secret, "[hidden]"), text)
      .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[address]")
      .replace(/\beyJ[\w-]{8,}\.[\w-]+\.[\w-]*/g, "[hidden]")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 400);
}

function summary(markdown: string): void {
  const file = process.env["GITHUB_STEP_SUMMARY"];
  if (file) appendFileSync(file, `${markdown}\n`);
}

/** What each stage means for the people waiting for the release. */
const VERDICTS: Record<Stage, string> = {
  live: "Live: Microsoft has published it.",
  "in-progress":
    "Not live yet: Microsoft is still checking or publishing it. Run the Microsoft Store workflow with status to see how it ends.",
  draft: `Not submitted: the submission is a draft nobody committed. To commit it, ${RECOVER}.`,
  failed:
    "Not live: Microsoft refused or stopped the submission. Partner Center says why; docs/maintainers/microsoft-store.md#when-a-submission-fails says what to do.",
  absent: "The Store has no submission of this release.",
};

/** Prints an outcome, each part on its own line, and fails the run unless the stage is in `fine`. */
function report(outcome: Outcome, fine: readonly Stage[]): void {
  const rows = [
    ["GitHub release", outcome.version],
    ["Commit", outcome.commit],
    [
      "Store package",
      `${outcome.packageVersion}${outcome.fileName ? `, ${outcome.fileName}` : ""}`,
    ],
    ["Submission", outcome.submissionId ?? "none"],
    ["Microsoft's status", outcome.status ?? "none"],
  ];
  const verdict = VERDICTS[outcome.stage];
  console.log([...rows.map((row) => row.join(": ")), ...outcome.remarks, verdict].join("\n"));
  summary(
    [
      `### Microsoft Store: ${outcome.version}`,
      "| | |",
      "| --- | --- |",
      ...rows.map(([name, value]) => `| ${name} | \`${value}\` |`),
      "",
      verdict,
      ...outcome.remarks.map((remark) => `- ${remark}`),
    ].join("\n"),
  );
  const output = process.env["GITHUB_OUTPUT"];
  if (output) {
    appendFileSync(
      output,
      `submission-id=${outcome.submissionId ?? ""}\nstatus=${outcome.status ?? ""}\nstage=${outcome.stage}\n`,
    );
  }
  if (!fine.includes(outcome.stage)) throw new StoreError([verdict, ...outcome.remarks].join(" "));
  console.log(`::notice::Microsoft Store, ${outcome.version}: ${verdict}`);
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { release: { type: "string" } },
  });
  const [command] = positionals;
  const env = process.env;
  const lacking = [
    ["the variable STORE_TENANT_ID", env["STORE_TENANT_ID"]],
    ["the variable STORE_CLIENT_ID", env["STORE_CLIENT_ID"]],
    ["the secret STORE_CLIENT_SECRET", env["STORE_CLIENT_SECRET"]],
  ].flatMap(([name, value]) => (value ? [] : [name]));
  if (lacking.length > 0) {
    throw new StoreError(
      `The ${STORE_ENVIRONMENT} environment lacks ${lacking.join(", ")}. scripts/setup-microsoft-store.sh stores them.`,
    );
  }
  const access: StoreAccess = {
    tenantId: env["STORE_TENANT_ID"] ?? "",
    clientId: env["STORE_CLIENT_ID"] ?? "",
    clientSecret: env["STORE_CLIENT_SECRET"] ?? "",
    send: (url, request) => fetch(url, request),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  const expiry = keyExpiry(env["STORE_CLIENT_SECRET_EXPIRES"], Date.now());
  if (expiry) console.log(`::warning::${expiry}`);
  const release = values.release ? readStoreRelease(values.release) : null;
  const unnamed = "Enter the version of a published stable release, such as 0.0.5.";
  /** The release with its checked package, which sending needs. */
  const checked = (): CheckedRelease => {
    if (!release) throw new StoreError(unnamed);
    if (!release.package) throw new StoreError("The release's package wasn't checked first.");
    return { ...release, package: release.package };
  };

  switch (command) {
    case "preflight": {
      const { found, problems } = await preflight(access, release ? checked() : null);
      console.log(found.join("\n"));
      summary(
        [
          "### Microsoft Store: preflight",
          ...found.map((line) => `- ${line}`),
          ...problems.map((line) => `- **Stops a submission:** ${line}`),
          "",
          "Nothing was sent or changed.",
        ].join("\n"),
      );
      if (problems.length > 0) throw new StoreError(problems.join(" "));
      console.log(
        "::notice::The Store account and listing are ready. Nothing was sent or changed.",
      );
      return;
    }
    case "submit":
      report(await submit(access, checked()), ["live", "in-progress"]);
      return;
    case "status":
      if (!release) throw new StoreError(unnamed);
      report(await status(access, release), ["live", "in-progress"]);
      return;
    default:
      throw new StoreError(`Unknown command "${command}". Use preflight, submit or status.`);
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    // This script's own messages hold nothing secret. Any other is cleaned like Microsoft's text.
    const message = error instanceof Error ? error.message : String(error);
    const clean = cleaner([process.env["STORE_CLIENT_SECRET"] ?? ""]);
    console.log(`::error::${error instanceof StoreError ? message : clean(message)}`);
    process.exit(1);
  });
}
