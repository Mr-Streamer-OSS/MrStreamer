import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as windows from "./e2e/installed-upgrade-windows.ts";
import { execFileSync } from "node:child_process";
import { runCommand, verifyCheckoutSource } from "./e2e/installed-upgrade.ts";
import { createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { producePackageReceipt, type PackageIdentity } from "../scripts/package-receipt.ts";
import {
  sha256,
  verifyPrivateCandidate,
  readReceipt,
  resolvePackages,
} from "./e2e/installed-upgrade-packages.ts";
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
  const run = {
    id: 900,
    run_attempt: 1,
    head_sha: identity.run.headCommit,
    status: "completed",
    conclusion: "success",
    run_number: 447,
    path: ".github/workflows/release.yml",
    head_repository: { full_name: identity.repository },
  };
  const github = {
    repository: identity.repository,
    json: async (path: string) => {
      if (path.startsWith("/actions/runs/900/attempts/")) return run;
      return artifacts.find((each) => path === `/actions/artifacts/${each.id}`);
    },
    bytes: async (path: string) => {
      if (path === "/actions/artifacts/30/zip") return archive;
      if (path === "/actions/artifacts/31/zip") return receiptZip;
      throw new Error(path);
    },
  };
  return { input, github, run };
}

describe("explicit unpublished Windows upgrade inputs", () => {
  it("verifies exact receipt identities and all bytes without a published candidate release", async () => {
    const { input, github } = fixture();
    const result = await verifyPrivateCandidate(github, input, true);
    expect(result.receipt.appVersion).toBe(input.request.appVersion);
    expect(result.files.size).toBe(3);
  });
  it.each(["workflow", "fork", "run number"])(
    "refuses a successful run with the wrong %s",
    async (field) => {
      const { input, github, run } = fixture();
      if (field === "workflow") run.path = ".github/workflows/other.yml";
      if (field === "fork") run.head_repository.full_name = "fork/player";
      if (field === "run number") run.run_number++;
      await expect(verifyPrivateCandidate(github, input, true)).rejects.toThrow(
        "Private run identity",
      );
    },
  );
  it("uses verified published Stable with a private candidate and refuses private receipts in published mode or with a changed installer hash", async () => {
    const { input, github } = fixture();
    const verified = await verifyPrivateCandidate(github, input, true);
    const setup = strToU8("published Stable installer");
    const hash = sha256(setup);
    const sha512 = createHash("sha512").update(setup).digest("base64");
    const name = "Mr-Streamer-0.0.21-win-x64-setup.exe";
    const metadata = {
      version: "0.0.21",
      path: name,
      sha512,
      files: [{ url: name, sha512, size: setup.length }],
    };
    const sums = strToU8(`${hash}  ${name}`);
    const assets = [
      { id: 1, name, bytes: setup },
      { id: 2, name: "SHA256SUMS.txt", bytes: sums },
      { id: 3, name: "latest.yml", bytes: strToU8(JSON.stringify(metadata)) },
    ];
    const release = {
      tag_name: "v0.0.21",
      draft: false,
      prerelease: false,
      published_at: "2026-10-29T00:00:00Z",
      assets: assets.map(({ id, name, bytes }) => ({ id, name, size: bytes.length })),
    };
    const api = {
      repository: input.repository,
      json: async (path: string) => {
        if (path === "") return { default_branch: "main" };
        if (path === "/releases?per_page=100&page=1") return [release];
        if (path === "/commits/v0.0.21") return { sha: "d".repeat(40) };
        if (path.startsWith("/compare/")) return { status: "ahead", ahead_by: 1, behind_by: 0 };
        if (path === "/releases/tags/v0.0.21") return release;
        throw new Error(`Unexpected published lookup: ${path}`);
      },
      bytes: async (path: string) => {
        const asset = assets.find((each) => path === `/releases/assets/${each.id}`);
        if (!asset) throw new Error(path);
        return asset.bytes;
      },
    };
    const { receipt } = await resolvePackages(api, {
      tag: `v${input.request.appVersion}`,
      private: verified,
    });
    expect(
      readReceipt(receipt, verified).packages.map((each) => each.provenance.releaseKind),
    ).toEqual(["stable", "private"]);
    expect(() => readReceipt(receipt)).toThrow("identity");
    const tampered = structuredClone(receipt);
    tampered.packages[1].sha256 = "0".repeat(64);
    expect(() => readReceipt(tampered, verified)).toThrow("identity");
    const json = api.json;
    api.json = async (path) =>
      path === `/compare/${input.request.run.headCommit}...main?per_page=1`
        ? { status: "diverged", ahead_by: 1, behind_by: 1 }
        : json(path);
    await expect(
      resolvePackages(api, { tag: `v${input.request.appVersion}`, private: verified }),
    ).rejects.toThrow(`main does not contain ${input.request.run.headCommit}`);
  });
  it("refuses a changed runtime fixture even with the correct verification commit pin", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "verification-source-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
    try {
      git("init", "--quiet");
      const folder = join(checkout, "apps", "desktop", "test");
      await mkdir(folder, { recursive: true });
      const fixture = join(folder, "fake-provider.ts");
      await writeFile(fixture, "original fixture");
      git("add", ".");
      git(
        "-c",
        "user.name=Upgrade contract",
        "-c",
        "user.email=upgrade@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "fixture",
      );
      const source = git("rev-parse", "HEAD");
      expect(verifyCheckoutSource(source, checkout)).toBe(source);
      await writeFile(fixture, "changed fixture");
      expect(() => verifyCheckoutSource(source, checkout)).toThrow("local tracked changes");
    } finally {
      await rm(checkout, { recursive: true, force: true });
    }
  });
  // Receipt identity and archive bytes are package-receipt.test.ts's; these are the private input's own gates.
  it.each(["repository", "nested root", "verification pin"])(
    "refuses a wrong Fleet %s before creating the journey or installing",
    async (failure) => {
      const { input, github } = fixture();
      const temp = await mkdtemp(join(tmpdir(), "private-upgrade-"));
      const root =
        failure === "nested root" ? join(temp, "redirect", "journey") : join(temp, "journey");
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
            repository: failure === "repository" ? "another/player" : input.repository,
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
            root,
            "--fleet-owner",
            join(temp, "owner.json"),
            "--repository",
            input.repository,
            "--verification-source",
            "e".repeat(40),
          ]),
        ).rejects.toThrow(
          {
            repository: "another repository",
            "nested root": "new direct child",
            "verification pin": "actual checkout",
          }[failure],
        );
        await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        runner.mockRestore();
        await rm(temp, { recursive: true, force: true });
      }
    },
  );
  it.each(["platform", "distribution", "attempt", "hash"])(
    "refuses a wrong %s before installation",
    async (field) => {
      const { input, github } = fixture();
      const bad = structuredClone(input);
      if (field === "platform") Object.assign(bad.request, { platform: "mac-arm64" });
      if (field === "distribution") Object.assign(bad.request, { distribution: "store" });
      if (field === "attempt") bad.request.run.attempt++;
      if (field === "hash") bad.artifacts[0]!.digest = `sha256:${"0".repeat(64)}`;
      const message = {
        platform: /win-x64/,
        distribution: /direct/,
        attempt: /Private run identity/,
        hash: /artifact metadata differs/,
      }[field];
      await expect(verifyPrivateCandidate(github, bad, true)).rejects.toThrow(message);
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
    expect(() =>
      fleetRunner({
        vmId: "abc123",
        task: "upgrade",
        nonce: "a".repeat(64),
        temp: "C:\\task",
        disposable: false,
      }),
    ).toThrow(/disposable/);
  });
});
