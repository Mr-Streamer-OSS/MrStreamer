// The Developer ID Application identity GitHub Actions signs Mac releases with. It ends up in this
// repository's Actions secrets MAC_CERTIFICATE_P12 and MAC_CERTIFICATE_PASSWORD.
//
//   node scripts/ci-signing-identity.ts request   create a private key and certificate request
//   node scripts/ci-signing-identity.ts finish [--cer FILE]
//                                                 pair the issued certificate with the key and
//                                                 store both in the repository secrets
//   node scripts/ci-signing-identity.ts status    list the team's Developer ID certificates
//
// `request` keeps the key in .local/ci-signing (never committed) until `finish` stores it and
// deletes the folder, so the key leaves this machine only inside the encrypted bundle sent to
// GitHub. Only the Account Holder can create Developer ID certificates: `request` first asks the
// App Store Connect API and otherwise prints the request to upload at developer.apple.com.
// `finish` finds the issued certificate through the API, or reads the downloaded --cer file.
// API calls need ASC_KEY_PATH, ASC_KEY_ID and ASC_ISSUER_ID. Needs openssl, and gh signed in with
// admin access to the repository. docs/maintainers/signing.md covers renewal.
import { execFileSync } from "node:child_process";
import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  X509Certificate,
  type KeyObject,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

// Apple issues Developer ID certificates from its G2 authority; older accounts may only offer the
// original type.
const CERTIFICATE_TYPES = ["DEVELOPER_ID_APPLICATION_G2", "DEVELOPER_ID_APPLICATION"] as const;
const PENDING = join(".local", "ci-signing");
const KEY_FILE = join(PENDING, "key.pem");
const REQUEST_FILE = join(PENDING, "mr-streamer-ci.certSigningRequest");

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { cer: { type: "string" } },
});

const ascKey = (() => {
  const path = process.env["ASC_KEY_PATH"];
  const keyId = process.env["ASC_KEY_ID"];
  const issuer = process.env["ASC_ISSUER_ID"];
  return path && keyId && issuer ? { path, keyId, issuer } : null;
})();

interface ApiCertificate {
  readonly attributes: {
    readonly displayName: string;
    readonly serialNumber: string;
    readonly expirationDate: string;
    readonly certificateContent: string;
  };
}

class ApiError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`App Store Connect answered ${status}: ${detail}`);
    this.status = status;
  }
}

switch (positionals[0]) {
  case "request":
    await request();
    break;
  case "finish":
    await finish();
    break;
  case "status":
    for (const { attributes } of await developerIdCertificates()) {
      console.log(
        `${attributes.displayName}  serial ${attributes.serialNumber}  expires ${attributes.expirationDate.slice(0, 10)}`,
      );
    }
    break;
  default:
    throw new Error("Usage: node scripts/ci-signing-identity.ts request|finish|status");
}

async function request(): Promise<void> {
  if (existsSync(KEY_FILE)) {
    console.log(`A request is already pending in ${PENDING}; finish it or delete the folder.`);
  } else {
    mkdirSync(PENDING, { recursive: true, mode: 0o700 });
    run("openssl", [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      KEY_FILE,
      "-out",
      REQUEST_FILE,
      "-subj",
      "/CN=Mr. Streamer release signing",
    ]);
  }
  const csrContent = readFileSync(REQUEST_FILE, "utf8");
  if (ascKey) {
    for (const certificateType of CERTIFICATE_TYPES) {
      try {
        await api("POST", "/certificates", {
          data: { type: "certificates", attributes: { certificateType, csrContent } },
        });
        console.log(`Apple issued a ${certificateType} certificate. Run: ${finishCommand()}`);
        return;
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        console.log(`${certificateType} through the API: ${error.message}`);
      }
    }
  }
  console.log(
    [
      "",
      "The Account Holder creates the certificate at developer.apple.com:",
      `  1. Save the request below as ${REQUEST_FILE.split("/").pop()} on the computer with the browser.`,
      "  2. Open https://developer.apple.com/account/resources/certificates/add",
      "  3. Choose Developer ID Application, then the G2 Sub-CA, upload the request and continue.",
      `  4. Run: ${finishCommand()}`,
      "",
      csrContent,
    ].join("\n"),
  );
}

async function finish(): Promise<void> {
  if (!existsSync(KEY_FILE))
    throw new Error(`No pending request in ${PENDING}; run request first.`);
  const key = createPrivateKey(readFileSync(KEY_FILE));
  const certificate = values.cer
    ? new X509Certificate(readFileSync(values.cer))
    : await issuedFor(key);
  if (!certificate) {
    throw new Error("Apple lists no Developer ID certificate for this request yet.");
  }
  if (!certificate.checkPrivateKey(key)) {
    throw new Error("That certificate belongs to a different key.");
  }

  // The runner's keychain needs the intermediate authority to trust the identity.
  const issuerUrl = /CA Issuers - URI:(\S+)/.exec(certificate.infoAccess ?? "")?.[1];
  if (!issuerUrl) throw new Error("The certificate names no issuing authority.");
  const issuer = new X509Certificate(Buffer.from(await (await fetch(issuerUrl)).arrayBuffer()));
  if (!certificate.verify(issuer.publicKey)) throw new Error(`${issuerUrl} did not sign it.`);
  writeFileSync(join(PENDING, "cert.pem"), certificate.toString());
  writeFileSync(join(PENDING, "issuer.pem"), issuer.toString());

  // SHA-1 and 3DES keep the bundle readable by every macOS `security import`.
  const password = randomBytes(24).toString("base64url");
  const bundlePath = join(PENDING, "identity.p12");
  run(
    "openssl",
    [
      "pkcs12",
      "-export",
      "-inkey",
      KEY_FILE,
      "-in",
      join(PENDING, "cert.pem"),
      "-certfile",
      join(PENDING, "issuer.pem"),
      "-name",
      "Mr. Streamer release signing",
      "-keypbe",
      "PBE-SHA1-3DES",
      "-certpbe",
      "PBE-SHA1-3DES",
      "-macalg",
      "sha1",
      "-passout",
      "env:P12_PASSWORD",
      "-out",
      bundlePath,
    ],
    { env: { ...process.env, P12_PASSWORD: password } },
  );

  const repo = run("gh", [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "--jq",
    ".nameWithOwner",
  ]).trim();
  const bundle = readFileSync(bundlePath).toString("base64");
  run("gh", ["secret", "set", "MAC_CERTIFICATE_P12", "--repo", repo], { input: bundle });
  run("gh", ["secret", "set", "MAC_CERTIFICATE_PASSWORD", "--repo", repo], { input: password });
  rmSync(PENDING, { recursive: true, force: true });
  console.log(`Stored ${/CN=(.+)/.exec(certificate.subject)?.[1]} in ${repo}'s Actions secrets.`);
  console.log(`Serial ${certificate.serialNumber}, valid until ${certificate.validTo}.`);
}

/** The team's Developer ID certificate whose public key matches the pending request. */
async function issuedFor(key: KeyObject): Promise<X509Certificate | null> {
  const wanted = createPublicKey(key).export({ type: "spki", format: "der" });
  for (const { attributes } of await developerIdCertificates()) {
    const certificate = new X509Certificate(Buffer.from(attributes.certificateContent, "base64"));
    if (certificate.publicKey.export({ type: "spki", format: "der" }).equals(wanted)) {
      return certificate;
    }
  }
  return null;
}

async function developerIdCertificates(): Promise<readonly ApiCertificate[]> {
  const found = (await api(
    "GET",
    `/certificates?filter[certificateType]=${CERTIFICATE_TYPES.join(",")}&limit=200`,
  )) as { data: ApiCertificate[] };
  return found.data;
}

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`https://api.appstoreconnect.apple.com/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await response.json().catch(() => null)) as {
    errors?: { detail?: string; title?: string }[];
  } | null;
  if (!response.ok) {
    const detail = json?.errors?.map((error) => error.detail ?? error.title).join("; ");
    throw new ApiError(response.status, detail || response.statusText);
  }
  return json;
}

/** A short-lived App Store Connect API token. */
function token(): string {
  if (!ascKey) throw new Error("Set ASC_KEY_PATH, ASC_KEY_ID and ASC_ISSUER_ID for API calls.");
  const now = Math.floor(Date.now() / 1000);
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${part({ alg: "ES256", kid: ascKey.keyId, typ: "JWT" })}.${part({
    iss: ascKey.issuer,
    iat: now,
    exp: now + 600,
    aud: "appstoreconnect-v1",
  })}`;
  const key = createPrivateKey(readFileSync(ascKey.path));
  const signature = sign("sha256", Buffer.from(body), { key, dsaEncoding: "ieee-p1363" });
  return `${body}.${signature.toString("base64url")}`;
}

function finishCommand(): string {
  return ascKey
    ? "node scripts/ci-signing-identity.ts finish"
    : "node scripts/ci-signing-identity.ts finish --cer <downloaded .cer>";
}

function run(
  command: string,
  args: readonly string[],
  options: { input?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "inherit"],
    ...options,
  });
}
