import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { producePackageReceipt, type PackageIdentity } from "../scripts/package-receipt.ts";
import { sha256, verifyPrivateCandidate } from "./e2e/installed-upgrade-packages.ts";
import { fleetRunner } from "./e2e/installed-upgrade-windows.ts";

function fixture() {
  const version = "0.0.22-nightly.20261029.447";
  const files = new Map(
    [
      `Mr-Streamer-${version}-win-x64-setup.exe`,
      `Mr-Streamer-${version}-win-x64-setup.exe.blockmap`,
      "latest.yml",
    ].map((name) => [name, strToU8(name)]),
  );
  const archive = zipSync(Object.fromEntries(files));
  const identity: PackageIdentity = {
    repository: "owner/player",
    sourceCommit: "a".repeat(40),
    workflowCommit: "b".repeat(40),
    appVersion: version,
    packageVersion: version,
    platform: "win-x64",
    distribution: "direct",
    run: { id: 900, attempt: 1, headCommit: "c".repeat(40) },
    artifact: { id: 30, name: `release-win-x64-${version}`, sha256: sha256(archive) },
  };
  const receipt = producePackageReceipt(identity, files);
  const receiptZip = zipSync({ "package-receipt.json": strToU8(JSON.stringify(receipt)) });
  const artifact = {
    id: 30,
    name: identity.artifact.name,
    digest: `sha256:${sha256(archive)}`,
    expired: false,
    expires_at: "2099-01-01T00:00:00Z",
    workflow_run: { id: 900, head_sha: identity.run.headCommit },
  };
  const artifacts = [
    artifact,
    {
      ...artifact,
      id: 31,
      name: `package-receipt-win-x64-direct-${version}-attempt-1`,
      digest: `sha256:${sha256(receiptZip)}`,
    },
  ];
  const input = { repository: identity.repository, request: { ...identity }, artifacts };
  const github = {
    repository: identity.repository,
    json: async (path: string) => {
      if (path === "/actions/runs/900/attempts/1")
        return {
          id: 900,
          run_attempt: 1,
          head_sha: identity.run.headCommit,
          status: "completed",
          conclusion: "success",
        };
      return artifacts.find((each) => path === `/actions/artifacts/${each.id}`);
    },
    bytes: async (path: string) => {
      if (path === "/actions/artifacts/30/zip") return archive;
      if (path === "/actions/artifacts/31/zip") return receiptZip;
      throw new Error(path);
    },
  };
  return { input, github };
}

describe("explicit unpublished Windows upgrade inputs", () => {
  it("verifies exact receipt identities and all bytes without a published candidate release", async () => {
    const { input, github } = fixture();
    const result = await verifyPrivateCandidate(github, input, true);
    expect(result.receipt.appVersion).toBe(input.request.appVersion);
    expect(result.receipt.workflowCommit).not.toBe(result.receipt.sourceCommit);
    expect(result.files.size).toBe(3);
  });
  it.each(["sourceCommit", "workflowCommit", "platform", "distribution", "attempt", "hash"])(
    "refuses a wrong %s before installation",
    async (field) => {
      const { input, github } = fixture();
      const bad = structuredClone(input);
      if (field === "sourceCommit" || field === "workflowCommit")
        bad.request[field] = "d".repeat(40);
      if (field === "platform") Object.assign(bad.request, { platform: "mac-arm64" });
      if (field === "distribution") Object.assign(bad.request, { distribution: "store" });
      if (field === "attempt") bad.request.run.attempt++;
      if (field === "hash") bad.artifacts[0]!.digest = `sha256:${"0".repeat(64)}`;
      await expect(verifyPrivateCandidate(github, bad, true)).rejects.toThrow();
    },
  );
  it("refuses a non-Fleet ownership declaration", () => {
    expect(() => fleetRunner({ disposable: false })).toThrow();
  });
});
