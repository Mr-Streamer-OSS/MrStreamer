import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
// Paths keep forward slashes on Windows too, so git matches them against .gitignore.
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

const { dirname, join } = posix;

// Every repository path a Markdown file in the checkout names in backticks exists, so a reader
// following the docs finds the file. A path counts from the repository root or from a folder
// holding the document, as an app's README names `src/...` inside its app. A path that only makes
// sense with the app named in the sentence before it is written from the root instead. Gitignored
// paths are build output the docs describe, so they count as found; .gitignore's unanchored
// `out/`, `dist/` and `vendor/` make that true under any folder of that name. A path with
// brackets, a plus sign or a space, such as an Expo Router route, isn't read as one and goes
// unchecked.
//
// `node scripts/docs-references.ts` needs no install, so a docs-only Check can run it;
// test/docs-references.test.ts runs it with the suite.

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

/** Each `document: path` in the checkout at `root` whose path is found nowhere. */
export function missingReferences(root: string): string[] {
  // Tracked and new, not yet added, Markdown; -z keeps unusual names unquoted.
  const documents = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "*.md"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean);

  // Each reference not on disk, with the places it could be. Git is asked about all at once.
  const absent: { reference: string; candidates: string[] }[] = [];

  for (const document of documents) {
    // A tracked file deleted but not yet removed from the index has nothing to read.
    if (!existsSync(join(root, document))) continue;
    const text = readFileSync(join(root, document), "utf8");

    for (const [, quoted = ""] of text.matchAll(/`([^`\n]+)`/g)) {
      // A line number, anchor or closing punctuation after the path isn't part of it.
      const path = quoted
        .trim()
        .replaceAll("\\", "/")
        .replace(/[:#].*$/, "")
        .replace(/[.,)]+$/, "");

      // `./x` and `../x` count from the document's own folder only.
      const relative = /^\.\.?\//.test(path);

      if (!(relative ? /^[\w./@-]+$/.test(path) : pathLike.test(path))) continue;

      if (elsewhere.has(`${document} ${path}`)) continue;

      const candidates = relative
        ? [join(dirname(document), path)]
        : folders(document).map((folder) => join(folder, path));

      // A path that climbs out of the checkout is missing, whatever lies outside it.
      const inside = candidates.filter(
        (candidate) => candidate !== ".." && !candidate.startsWith("../"),
      );

      if (inside.some((candidate) => existsSync(join(root, candidate)))) continue;
      absent.push({ reference: `${document}: ${path}`, candidates: inside });
    }
  }

  if (!absent.length) return [];

  const asked = spawnSync("git", ["check-ignore", "--no-index", "-z", "--stdin"], {
    cwd: root,
    encoding: "utf8",
    input: absent.flatMap(({ candidates }) => candidates).join("\0"),
  });

  // Status 1 means none is ignored; anything else but 0 is git failing.
  if (asked.status !== 0 && asked.status !== 1)
    throw new Error(`git check-ignore: ${asked.stderr}`);
  // -z keeps names with other characters unquoted, both ways.
  const ignored = new Set(asked.stdout.split("\0"));

  return absent.flatMap(({ reference, candidates }) =>
    candidates.some((candidate) => ignored.has(candidate)) ? [] : [reference],
  );
}

if (import.meta.main) {
  // The native path of the checkout, which posix joins would garble on Windows.
  const missing = missingReferences(fileURLToPath(new URL("..", import.meta.url)));

  for (const line of missing) console.error(`missing path ${line}`);

  if (missing.length) process.exitCode = 1;
}
