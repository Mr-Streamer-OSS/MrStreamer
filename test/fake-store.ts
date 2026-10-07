// A stand-in for Microsoft that the Store scripts' tests talk to in place of the network: Entra's
// token endpoint, the Store submission API for one app, and the Azure storage a package is
// uploaded to. It behaves as Microsoft's documentation describes: a new submission copies the
// published one, the Store takes one submission at a time, and a commit is checked afterwards.
// Also writes the packages the tests send, small files with a real manifest.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord, STORE_APP, STORE_NAME } from "../scripts/store-release.ts";
import type { Send, StoreAccess } from "../scripts/store-submission.ts";
import { readZipEntry, storedZip } from "../scripts/zip.ts";

const TENANT = "0a1b2c3d-1111-2222-3333-444455556666";
const CLIENT = "9f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff";
const KEY = "key~Only.The-Environment_Holds";
const TOKEN = "eyJ0eXAiOiJKV1Qi.eyJhdWQiOiJzdG9yZSJ9.c2lnbmF0dXJl";
const SIGNATURE = "c2FzLXNpZ25hdHVyZQ%3D%3D";
const API = `https://manage.devcenter.microsoft.com/v1.0/my/applications/${STORE_APP.id}`;

type Submission = Record<string, unknown> & {
  id: string;
  status: string;
  applicationPackages: Record<string, unknown>[];
};

/**
 * How a request goes wrong: "unanswered" never reaches Microsoft, "lost" reaches it but its answer
 * doesn't come back, and a number is answered with that HTTP status and `body`, unprocessed.
 */
type Fault = "unanswered" | "lost" | number;

/** Microsoft's word on a submission, with the errors it gives when it refuses one. */
type Verdict = string | { status: string; errors: { code: string; details: string }[] };

const artifacts: string[] = [];

/** Removes the folders `writeArtifact` made. */
export function removeArtifacts(): void {
  for (const dir of artifacts.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** The build a package comes from, and what its manifest says where that should differ. */
export interface Built {
  readonly version: string;
  readonly commit: string;
  readonly packageVersion: string;
  readonly identityName?: string;
  readonly publisher?: string;
  readonly architecture?: string;
  /** The app's name in the manifest, when the package was built before the Store name. */
  readonly displayName?: string;
  /** The version in the manifest, when it isn't the one the record names. */
  readonly manifestVersion?: string;
  /** Bytes added to the file, for a package larger than one upload block. */
  readonly padding?: number;
}

/**
 * Writes a release run's artifact into a new folder: the package, with a manifest for `built`,
 * and the record the build job leaves beside it. Returns the folder and the file's checksum.
 */
export function writeArtifact(built: Built): { dir: string; sha256: string } {
  const identity = [
    `Name="${built.identityName ?? STORE_APP.identityName}"`,
    `Publisher="${built.publisher ?? STORE_APP.publisher}"`,
    `Version="${built.manifestVersion ?? built.packageVersion}"`,
    `ProcessorArchitecture="${built.architecture ?? STORE_APP.architecture}"`,
  ].join(" ");
  const properties = `<Properties>\n    <DisplayName>${built.displayName ?? STORE_NAME}</DisplayName>\n  </Properties>`;
  const manifest = `<?xml version="1.0" encoding="utf-8"?>\n<Package>\n  <Identity ${identity} />\n  ${properties}\n</Package>${" ".repeat(built.padding ?? 0)}`;
  const file = storedZip("AppxManifest.xml", Buffer.from(manifest));
  const sha256 = createHash("sha256").update(file).digest("hex");
  const dir = mkdtempSync(join(tmpdir(), "mr-streamer-store-"));
  artifacts.push(dir);
  const path = join(dir, `Mr-Streamer-${built.version}-win-x64.msix`);
  writeFileSync(path, file);
  writeFileSync(
    `${path}.json`,
    JSON.stringify({
      version: built.version,
      packageVersion: built.packageVersion,
      commit: built.commit,
      sha256,
    }),
  );
  return { dir, sha256 };
}

/**
 * The Store with Mr. Streamer 0.0.4 published as submission 1001, and nothing in progress. Its
 * listings, in two languages, carry `title`: the Store name, unless they are from before it.
 */
export function fakeStore({ title = STORE_NAME } = {}) {
  const submissions = new Map<string, Submission>();
  /** The uploaded ZIP per upload address, and the blocks it is made of. */
  const blobs = new Map<string, { blocks: Map<string, Buffer>; zip: Buffer | null }>();
  const requests: string[] = [];
  const sent = new Map<string, unknown>();
  const faults: { request: string; fault: Fault; body: string }[] = [];
  /** What a committed submission goes through, one step per read of its status. */
  let progress: Verdict[] = [];
  const waits: number[] = [];
  let app: Record<string, unknown> = {
    id: STORE_APP.id,
    primaryName: "Mr. Streamer",
    packageIdentityName: STORE_APP.identityName,
    publisherName: STORE_APP.publisher,
  };
  let publishedId = "1001";
  let pendingId: string | null = null;
  let nextId = 1002;

  submissions.set("1001", {
    id: "1001",
    applicationCategory: "Entertainment",
    pricing: { trialPeriod: "NoFreeTrial", marketSpecificPricings: {}, sales: [], priceId: "Free" },
    visibility: "Public",
    targetPublishMode: "Immediate",
    targetPublishDate: "1601-01-01T00:00:00Z",
    listings: {
      "en-us": {
        baseListing: {
          title,
          description: "Plays the subscription you already have.",
          keywords: ["m3u", "xmltv"],
          features: ["Live TV with a guide"],
          releaseNotes: "What 0.0.4 changed.",
          images: [
            { id: "7001", fileName: "home.png", fileStatus: "Uploaded", imageType: "Screenshot" },
            { id: "7002", fileName: "guide.png", fileStatus: "Uploaded", imageType: "Screenshot" },
          ],
        },
        platformOverrides: {},
      },
      "nl-nl": {
        baseListing: {
          title,
          description: "Speelt het abonnement af dat je al hebt.",
          keywords: ["m3u", "xmltv"],
          features: ["Live tv met een gids"],
          releaseNotes: "Wat 0.0.4 veranderde.",
          images: [
            { id: "7003", fileName: "start.png", fileStatus: "Uploaded", imageType: "Screenshot" },
          ],
        },
        platformOverrides: {},
      },
    },
    notesForCertification: "Use the reviewers' playlist.",
    status: "Published",
    statusDetails: { errors: [], warnings: [], certificationReports: [] },
    fileUploadUrl: uploadUrl("1001"),
    applicationPackages: [
      {
        id: "9001",
        fileName: "Mr-Streamer-0.0.4-win-x64.msix",
        fileStatus: "Uploaded",
        version: "1.0.4.0",
        architecture: "x64",
        capabilities: ["runFullTrust"],
        minimumDirectXVersion: "None",
        minimumSystemRam: "None",
      },
    ],
    packageDeliveryOptions: { packageRollout: { isPackageRollout: false } },
    friendlyName: "Submission 1",
    trailers: [{ id: "8001", videoFileName: "trailer.mp4", videoFileId: "8002" }],
    // A field Microsoft's documentation doesn't name, as a later version of the API may add.
    storeBadgeCampaign: { enabled: true, markets: ["BE", "NL"] },
  });

  function uploadUrl(id: string): string {
    return `https://ingestion.blob.core.windows.net/ingestion/upload-${id}?sv=2022-11-02&sr=b&sig=${SIGNATURE}&se=2026-10-06T00%3A00%3A00Z&sp=rwl`;
  }

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "MS-CorrelationId": "6f1c2a34-0000-4000-8000-00000000c0de", ...headers },
    });
  const refused = (status: number, code: string, message: string) =>
    json(status, { code, message, source: "Ingestion Api" });

  /** The package version in an uploaded file's manifest, as Microsoft reads it. */
  function versionIn(zip: Buffer | null, fileName: string): string | null {
    const file = zip && readZipEntry(zip, fileName);
    const manifest = file && readZipEntry(file, "AppxManifest.xml")?.toString("utf8");
    return (manifest && /\sVersion="([^"]*)"/.exec(manifest)?.[1]) || null;
  }

  /** What Microsoft makes of a committed submission's files once it looks at them. */
  function check(submission: Submission): void {
    const zip = blobs.get(submission.id)?.zip ?? null;
    for (const file of submission.applicationPackages) {
      if (file["fileStatus"] !== "PendingUpload") continue;
      const version = versionIn(zip, String(file["fileName"]));
      if (version) {
        file["version"] = version;
      } else {
        submission.status = "CommitFailed";
        submission["statusDetails"] = {
          errors: [{ code: "InvalidState", details: `${file["fileName"]} is not in the upload.` }],
          warnings: [],
          certificationReports: [],
        };
        return;
      }
    }
    move(submission, progress.shift() ?? "PreProcessing");
  }

  function move(submission: Submission, verdict: Verdict): void {
    submission.status = typeof verdict === "string" ? verdict : verdict.status;
    if (typeof verdict === "string") return;
    submission["statusDetails"] = {
      errors: verdict.errors,
      warnings: [],
      certificationReports: [],
    };
  }

  function api(method: string, path: string, body: unknown): Response {
    const [, id, action] = /^\/submissions(?:\/(\d+))?(?:\/(\w+))?$/.exec(path) ?? [];
    const submission = id ? submissions.get(id) : undefined;
    if (method === "GET" && path === "") {
      return json(200, {
        ...app,
        lastPublishedApplicationSubmission: { id: publishedId },
        ...(pendingId && { pendingApplicationSubmission: { id: pendingId } }),
      });
    }
    if (method === "POST" && path === "/submissions") {
      if (pendingId) return refused(409, "InvalidState", "A submission is in progress already.");
      const copy: Submission = structuredClone(submissions.get(publishedId)!);
      copy.id = String(nextId++);
      copy.status = "PendingCommit";
      copy["fileUploadUrl"] = uploadUrl(copy.id);
      copy["friendlyName"] = `Submission ${copy.id}`;
      submissions.set(copy.id, copy);
      pendingId = copy.id;
      return json(201, copy);
    }
    if (!submission || !id) return refused(404, "NotFound", "No such submission.");
    if (method === "GET" && !action) return json(200, submission);
    if (method === "GET" && action === "status") {
      if (submission.status === "CommitStarted") check(submission);
      else if (id === pendingId && progress.length > 0) move(submission, progress.shift()!);
      return json(200, { status: submission.status, statusDetails: submission["statusDetails"] });
    }
    if (id !== pendingId || submission.status !== "PendingCommit") {
      return refused(409, "InvalidState", "The submission can't change in its current state.");
    }
    if (method === "PUT" && !action && isRecord(body)) {
      const { status, statusDetails, fileUploadUrl, friendlyName } = submission;
      const files = Array.isArray(body["applicationPackages"]) ? body["applicationPackages"] : [];
      const updated: Submission = {
        ...body,
        id,
        status,
        statusDetails,
        fileUploadUrl,
        friendlyName,
        applicationPackages: files.filter(isRecord),
      };
      submissions.set(id, updated);
      return json(200, updated);
    }
    if (method === "POST" && action === "commit") {
      submission.status = "CommitStarted";
      return json(202, { status: "CommitStarted" });
    }
    return refused(405, "MethodNotAllowed", "Not supported.");
  }

  function storage(url: URL, body: string | Uint8Array | undefined): Response {
    const id = url.pathname.replace("/ingestion/upload-", "");
    if (encodeURIComponent(url.searchParams.get("sig") ?? "") !== SIGNATURE) {
      return new Response("AuthenticationFailed", { status: 403 });
    }
    const blob = blobs.get(id) ?? { blocks: new Map<string, Buffer>(), zip: null };
    blobs.set(id, blob);
    if (url.searchParams.get("comp") === "block") {
      blob.blocks.set(url.searchParams.get("blockid") ?? "", Buffer.from(body ?? ""));
    } else {
      const listed = [...String(body).matchAll(/<Latest>([^<]+)<\/Latest>/g)];
      blob.zip = Buffer.concat(listed.map(([, block]) => blob.blocks.get(block ?? "")!));
    }
    return new Response(null, { status: 201 });
  }

  const send: Send = async (address, request) => {
    const url = new URL(address);
    const { method, body } = request;
    const name =
      url.hostname === "login.microsoftonline.com"
        ? "POST token"
        : url.hostname.endsWith(".blob.core.windows.net")
          ? `PUT ${url.searchParams.get("comp")}`
          : `${method} ${address.slice(API.length) || "/"}`;
    requests.push(name);
    const fault = faults.findIndex((each) => each.request === name);
    const { fault: kind, body: answer } = fault === -1 ? {} : faults.splice(fault, 1)[0]!;
    if (kind === "unanswered") throw new TypeError(`fetch failed: ${address}`);
    if (typeof kind === "number") return new Response(answer, { status: kind });

    let response: Response;
    if (name === "POST token") {
      const form = new URLSearchParams(String(body));
      const known =
        url.pathname === `/${TENANT}/oauth2/token` &&
        form.get("grant_type") === "client_credentials" &&
        form.get("client_id") === CLIENT &&
        form.get("client_secret") === KEY &&
        form.get("resource") === "https://manage.devcenter.microsoft.com";
      response = known
        ? json(200, { token_type: "Bearer", expires_in: "3599", access_token: TOKEN })
        : json(401, {
            error: "invalid_client",
            error_description: `AADSTS7000215: Invalid client secret provided for app '${CLIENT}'. Trace ID: 1234`,
          });
    } else if (name.startsWith("PUT block")) {
      response = storage(url, body);
    } else if (request.headers["Authorization"] !== `Bearer ${TOKEN}`) {
      response = refused(401, "Unauthorized", "The token is missing or wrong.");
    } else {
      const parsed: unknown = typeof body === "string" ? JSON.parse(body) : undefined;
      if (parsed !== undefined) sent.set(name, structuredClone(parsed));
      response = api(method, address.slice(API.length), parsed);
    }
    if (kind === "lost") throw new TypeError(`fetch failed: ${address}`);
    return response;
  };

  return {
    /** Every request in order, such as "POST /submissions" or "PUT block". */
    requests,
    /** The requests that change something at Microsoft, from the `from`th request on. */
    writes: (from = 0) =>
      requests.slice(from).filter((name) => !name.startsWith("GET") && name !== "POST token"),
    /** How long the script waited, each time. */
    waits,
    /** What must never be printed: the key, the token and the upload signature. */
    secrets: [KEY, TOKEN, SIGNATURE, decodeURIComponent(SIGNATURE)],
    access: (overrides: Partial<StoreAccess> = {}): StoreAccess => ({
      tenantId: TENANT,
      clientId: CLIENT,
      clientSecret: KEY,
      send,
      wait: async (ms) => void waits.push(ms),
      ...overrides,
    }),
    /** The JSON body of the last request called `name`. */
    sent(name: string): Record<string, unknown> {
      const body = sent.get(name);
      if (!isRecord(body)) throw new Error(`No ${name} carried a JSON object.`);
      return body;
    },
    published: () => submissions.get(publishedId)!,
    /** The ZIP uploaded for a submission. */
    uploaded: (id: string) => blobs.get(id)?.zip ?? null,
    /** Makes the next request called `name` go wrong. */
    fail(name: string, fault: Fault, body = ""): void {
      faults.push({ request: name, fault, body });
    },
    /** What the submission in progress goes through, one step per read of its status. */
    progress(...steps: Verdict[]): void {
      progress = steps;
    },
    /** Changes what the account says the application is. */
    rename(identity: Record<string, unknown>): void {
      app = { ...app, ...identity };
    },
    /** Changes the published submission, as someone would in Partner Center. */
    edit(changes: Record<string, unknown>): void {
      Object.assign(submissions.get(publishedId)!, changes);
    },
    /** A submission someone started in Partner Center, holding `fileName` at `status`. */
    start(status: string, fileName: string, version = ""): string {
      const id = String(nextId++);
      const packages = [{ id: "9100", fileName, fileStatus: "PendingUpload", version }];
      submissions.set(id, {
        ...structuredClone(submissions.get(publishedId)!),
        id,
        status,
        applicationPackages: packages,
      });
      pendingId = id;
      return id;
    },
    /**
     * Moves the submission in progress on. Published, it replaces the published one, with the
     * packages it removed gone.
     */
    advance(verdict: Verdict): void {
      const submission = submissions.get(pendingId ?? "");
      if (!submission) throw new Error("No submission is in progress.");
      move(submission, verdict);
      if (submission.status !== "Published") return;
      submission.applicationPackages = submission.applicationPackages
        .filter((file) => file["fileStatus"] !== "PendingDelete")
        .map((file) => ({ ...file, fileStatus: "Uploaded" }));
      publishedId = submission.id;
      pendingId = null;
    },
  };
}
