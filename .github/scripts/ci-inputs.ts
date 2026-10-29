import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { realpathSync, appendFileSync, readFileSync } from "node:fs";

/** Only known independent inputs may omit expensive work. Unknown inputs fail closed. */
export function selectChecks(paths: readonly string[] | null) {
  if (!paths?.length) return { desktop: true, website: true };
  let desktop = false;
  let website = false;
  for (const path of paths) {
    const websiteInput =
      path.startsWith("apps/marketing/") ||
      /^docs\/(assets\/|user\/|(?:privacy|about|security)\.md$)/.test(path) ||
      path === "apps/desktop/assets/brand/mark.svg";
    // The root test suite includes marketing tests as well as desktop and shared tests.
    if (websiteInput) {
      desktop = true;
      website = true;
    } else if (path.startsWith("apps/desktop/")) desktop = true;
    else if (
      path.startsWith("docs/") ||
      ["README.md", "AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"].includes(path)
    )
      continue;
    else return { desktop: true, website: true };
  }
  return { desktop, website };
}

/** Local Git has no API file-list cap; --no-renames includes both sides of moves. */
export function changedPaths(base: string, head: string, pullRequest: boolean): string[] | null {
  if (![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha))) return null;
  try {
    const diffBase = pullRequest
      ? execFileSync("git", ["merge-base", base, head], { encoding: "utf8" }).trim()
      : base;
    return execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", diffBase, head], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    })
      .split("\0")
      .filter(Boolean);
  } catch {
    return null;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const event = JSON.parse(readFileSync(process.env["GITHUB_EVENT_PATH"]!, "utf8"));
  const pr = process.env["GITHUB_EVENT_NAME"] === "pull_request";
  const paths = changedPaths(
    pr ? event.pull_request.base.sha : (event.before ?? ""),
    pr ? event.pull_request.head.sha : (process.env["GITHUB_SHA"] ?? ""),
    pr,
  );
  // Reusable release calls always validate the entire desktop profile.
  const selected = process.env["VALIDATION_SHA"]
    ? { desktop: true, website: false }
    : selectChecks(paths);
  appendFileSync(
    process.env["GITHUB_OUTPUT"]!,
    `desktop=${selected.desktop}\nwebsite=${selected.website}\n`,
  );
}
