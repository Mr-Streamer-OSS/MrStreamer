import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";

// Every repository path a tracked Markdown file names in backticks exists, so a reader following
// the docs finds the file. A path counts from the repository root or from a folder holding the
// document, as an app's README names `src/...` inside its app. A path that only makes sense with
// the app named in the sentence before it is written from the root instead. Gitignored paths are
// build output the docs describe, so they count as found.

const root = join(import.meta.dirname, "..");

/** A backticked token that reads as a path inside this repository. */
const pathLike =
  /^(?:apps|docs|packages|packaging|patches|scripts|test|tools|src|modules|\.agents|\.claude|\.cursor|\.github)\/[\w./@-]*$/;

/** Paths a document names on purpose although they are not in this repository. */
const elsewhere = new Set([
  // The wrong folder Vercel would look in.
  "apps/marketing/README.md apps/marketing/apps/marketing",
  // The repository-root script the dossier says does not exist.
  "docs/maintainers/ios-public-submission-dossier.md scripts/build-ffmpeg.sh",
  // Files in Electron's tree.
  "docs/maintainers/licences.md docs/development/build-instructions-gn.md",
  "docs/maintainers/licences.md patches/ffmpeg",
  "docs/maintainers/licences.md patches/ffmpeg/link_with_loader_path.patch",
]);

/** The document's folder and every folder above it, ending at the root. */
function folders(document: string): string[] {
  const found: string[] = [];
  for (let folder = dirname(document); folder !== "."; folder = dirname(folder)) found.push(folder);
  found.push(".");
  return found;
}

function ignored(path: string): boolean {
  return spawnSync("git", ["check-ignore", "--no-index", "-q", path], { cwd: root }).status === 0;
}

it("names only repository paths that exist", () => {
  const documents = execFileSync("git", ["ls-files", "*.md"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const missing: string[] = [];
  for (const document of documents) {
    const text = readFileSync(join(root, document), "utf8");
    for (const [, quoted = ""] of text.matchAll(/`([^`\n]+)`/g)) {
      // A line number, anchor or closing punctuation after the path isn't part of it.
      const path = quoted
        .trim()
        .replace(/[:#].*$/, "")
        .replace(/[.,)]+$/, "");
      if (!pathLike.test(path) || elsewhere.has(`${document} ${path}`)) continue;
      const candidates = folders(document).map((folder) => join(folder, path));
      if (candidates.some((candidate) => existsSync(join(root, candidate)) || ignored(candidate))) {
        continue;
      }
      missing.push(`${document}: ${path}`);
    }
  }
  expect(missing).toEqual([]);
});
