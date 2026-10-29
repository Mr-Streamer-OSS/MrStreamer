// Runs only in secretless Release jobs. API failures and stale/foreign evidence fall back.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptsEvidence, validationIdentity } from "./validation-evidence.ts";

// One budget covers every candidate run, API call and artifact download.
const deadline = Date.now() + 5 * 60_000;
function timeout() {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Validation lookup budget exhausted");
  return Math.min(30_000, remaining);
}

const repository = "Mr-Streamer-OSS/MrStreamer";
interface Run {
  id: number;
  run_attempt: number;
  head_sha: string;
  head_branch: string;
  event: string;
  path: string;
  status: string;
  conclusion: string;
  repository: { full_name: string };
  head_repository: { full_name: string };
}
function api<T>(path: string): T {
  return JSON.parse(
    execFileSync("gh", ["api", `repos/${repository}/${path}`], {
      encoding: "utf8",
      timeout: timeout(),
    }),
  ) as T;
}

async function reusable(): Promise<boolean> {
  const sha = process.env["VALIDATION_SHA"] ?? "";
  if (!/^[a-f0-9]{40}$/.test(sha)) return false;
  const runs = api<{ workflow_runs: Run[] }>(
    `actions/workflows/checks.yml/runs?event=push&branch=main&head_sha=${sha}&per_page=100`,
  ).workflow_runs;
  for (const found of runs) {
    if (Date.now() >= deadline) return false;
    let run = found;
    // Bound the wait; fallback retains independent 10/15 minute validation limits.
    while (run.status !== "completed" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(15_000, timeout())));
      run = api<Run>(`actions/runs/${run.id}`);
    }
    if (
      run.repository.full_name !== repository ||
      run.head_repository.full_name !== repository ||
      run.head_sha !== sha ||
      run.head_branch !== "main" ||
      run.event !== "push" ||
      run.path.split("@")[0] !== ".github/workflows/checks.yml" ||
      run.conclusion !== "success" ||
      run.status !== "completed"
    )
      continue;
    // Push workflows execute their source revision. Only main ancestors with identical trusted
    // validation tooling are accepted; artifact metadata cannot vouch for its producer.
    execFileSync("git", ["merge-base", "--is-ancestor", sha, "origin/main"], {
      timeout: timeout(),
    });
    execFileSync(
      "git",
      [
        "diff",
        "--exit-code",
        sha,
        process.env["WORKFLOW_SHA"]!,
        "--",
        ".github/workflows/checks.yml",
        ".github/actions/validation",
        ".github/scripts/validation-evidence.ts",
        ".github/scripts/ci-inputs.ts",
        ".github/tests",
      ],
      { timeout: timeout() },
    );
    const artifacts = api<{ artifacts: { id: number; name: string; expired: boolean }[] }>(
      `actions/runs/${run.id}/artifacts?per_page=100`,
    ).artifacts;
    const artifact = artifacts.find(
      (item) => item.name === `validation-${run.id}-${run.run_attempt}` && !item.expired,
    );
    if (!artifact) continue;
    const dir = mkdtempSync(join(tmpdir(), "release-validation-"));
    const zip = join(dir, "evidence.zip");
    writeFileSync(
      zip,
      execFileSync("gh", ["api", `repos/${repository}/actions/artifacts/${artifact.id}/zip`], {
        timeout: timeout(),
      }),
    );
    execFileSync("unzip", ["-q", zip, "-d", dir], { timeout: timeout() });
    const evidence: unknown = JSON.parse(readFileSync(join(dir, "validation.json"), "utf8"));
    if (
      acceptsEvidence(
        evidence,
        { sha, identity: validationIdentity() },
        {
          repository: run.repository.full_name,
          event: run.event,
          branch: run.head_branch,
          workflow: run.path.split("@")[0]!,
          sha: run.head_sha,
          conclusion: run.conclusion,
        },
      )
    ) {
      appendFileSync(
        process.env["GITHUB_STEP_SUMMARY"]!,
        `Reused Checks run ${run.id}, attempt ${run.run_attempt}, artifact ${artifact.id}, source ${sha}.\n`,
      );
      return true;
    }
  }
  return false;
}

try {
  appendFileSync(process.env["GITHUB_OUTPUT"]!, `reused=${await reusable()}\n`);
} catch {
  console.log("Validation evidence unavailable or incompatible; running shared fallback.");
  appendFileSync(process.env["GITHUB_OUTPUT"]!, "reused=false\n");
}
