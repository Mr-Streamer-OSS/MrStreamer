import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as windows from "./e2e/installed-upgrade-windows.ts";
import { runCommand } from "./e2e/installed-upgrade.ts";
import { zipSync, strToU8 } from "fflate";
import { describe, expect, it, vi } from "vitest";
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
    expect(result.files.size).toBe(3);
  });
  // Receipt identity and archive bytes are package-receipt.test.ts's; these are the private input's own gates.
  it("refuses a Fleet receipt from another repository before creating the journey or installing", async () => {
    const { input, github } = fixture();
    const temp = await mkdtemp(join(tmpdir(), "private-upgrade-"));
    const runner = vi.spyOn(windows, "fleetRunner").mockReturnValue({
      id: "test",
      temp,
      installRoot: join(temp, "install"),
      executable: join(temp, "app.exe"),
      tools: [],
    });
    try {
      await writeFile(join(temp, "owner.json"), "{}");
      await writeFile(join(temp, "private-input.json"), JSON.stringify(input));
      for (const id of [30, 31])
        await writeFile(
          join(temp, `artifact-${id}.zip`),
          await github.bytes(`/actions/artifacts/${id}/zip`),
        );
      const candidateTag = `v${input.request.appVersion}`;
      const pkg = (stage: "stable" | "candidate") => {
        const version = stage === "stable" ? "0.0.21" : input.request.appVersion;
        return {
          stage,
          version,
          source: stage === "stable" ? "d".repeat(40) : input.request.sourceCommit,
          file: `${stage}-Mr-Streamer-${version}-win-x64-setup.exe`,
          bytes: 1,
          sha256: "0".repeat(64),
          provenance: {
            tag: `v${version}`,
            releaseKind: stage === "stable" ? "stable" : "nightly",
            publishedAt: "2026-10-29T00:00:00Z",
            assetId: 1,
            assetDigest: null,
            metadata: {
              sha256sums: "0".repeat(64),
              latestYml: "0".repeat(64),
              sha512: "synthetic",
            },
          },
        };
      };
      await writeFile(
        join(temp, "receipt.json"),
        JSON.stringify({
          repository: "another/player",
          resolvedAt: "2026-10-29T00:00:00Z",
          resolved: {
            stableTag: "v0.0.21",
            stableSha: "d".repeat(40),
            candidateTag,
            candidateSha: input.request.sourceCommit,
          },
          packages: [pkg("stable"), pkg("candidate")],
          defaultBranch: "main",
          candidateAheadBy: 1,
          limits: [],
        }),
      );
      await expect(
        runCommand([
          "--packages",
          temp,
          "--root",
          join(temp, "journey"),
          "--fleet-owner",
          join(temp, "owner.json"),
          "--repository",
          input.repository,
          "--verification-source",
          "e".repeat(40),
        ]),
      ).rejects.toThrow("another repository");
      await expect(stat(join(temp, "journey"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      runner.mockRestore();
      await rm(temp, { recursive: true, force: true });
    }
  });
  it.each(["platform", "distribution", "attempt", "hash"])(
    "refuses a wrong %s before installation",
    async (field) => {
      const { input, github } = fixture();
      const bad = structuredClone(input);
      if (field === "platform") Object.assign(bad.request, { platform: "mac-arm64" });
      if (field === "distribution") Object.assign(bad.request, { distribution: "store" });
      if (field === "attempt") bad.request.run.attempt++;
      if (field === "hash") bad.artifacts[0]!.digest = `sha256:${"0".repeat(64)}`;
      await expect(verifyPrivateCandidate(github, bad, true)).rejects.toThrow();
    },
  );
  it.each(["C:\\Users\\agent", "C:\\Users\\agent\\AppData\\Local\\Temp\\..\\shared"])(
    "refuses unsafe Fleet temp %s before executing Windows commands",
    (temp) => {
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: "win32" });
      vi.stubEnv("GITHUB_ACTIONS", undefined);
      vi.stubEnv("GH_TOKEN", undefined);
      vi.stubEnv("GITHUB_TOKEN", undefined);
      vi.stubEnv("USERNAME", "agent");
      vi.stubEnv("LOCALAPPDATA", "C:\\Users\\agent\\AppData\\Local");
      vi.stubEnv("APPDATA", "C:\\Users\\agent\\AppData\\Roaming");
      try {
        expect(() =>
          fleetRunner({
            vmId: "abc123",
            task: "upgrade",
            nonce: "a".repeat(64),
            disposable: true,
            temp,
          }),
        ).toThrow("isolated task root");
      } finally {
        Object.defineProperty(process, "platform", platform);
        vi.unstubAllEnvs();
      }
    },
  );
  it("refuses a non-Fleet ownership declaration", () => {
    expect(() => fleetRunner({ disposable: false })).toThrow();
  });
});
