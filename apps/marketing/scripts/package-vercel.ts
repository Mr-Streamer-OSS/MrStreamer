// Packs the built site as Vercel's Build Output API, version 3, in .vercel/output/, and checks
// the package before anything deploys it: `vercel deploy --prebuilt` uploads exactly this folder.
//
//   node scripts/package-vercel.ts    (after `vite build`)
//
// - static/: everything in dist/.
// - config.json: /privacy and /privacy/ answer 302 to the privacy policy in the repository, ahead
//   of the files. The app and the Store listing link there. No builds.json: without one the CLI
//   deploys to the target it is told, where a builds.json naming a preview would win.
//
// Fails, listing every problem, when the page names a file the package lacks, when its address,
// description or social picture is missing, when robots.txt or the sitemap is, or when the
// privacy route doesn't answer exactly its two addresses.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SITE = "https://mrstreamer.app";
const PRIVACY = "https://github.com/Mr-Streamer-OSS/MrStreamer/blob/main/docs/privacy.md";

const root = join(import.meta.dirname, "..");
const output = join(root, ".vercel/output");
const files = join(output, "static");

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
cpSync(join(root, "dist"), files, { recursive: true });
const privacy = { src: "^/privacy/?$", status: 302, headers: { Location: PRIVACY } };
const config = { version: 3, routes: [privacy, { handle: "filesystem" }] };
writeFileSync(join(output, "config.json"), `${JSON.stringify(config, null, 2)}\n`);

const problems: string[] = [];
const read = (name: string) =>
  existsSync(join(files, name)) ? readFileSync(join(files, name), "utf8") : "";

const page = read("index.html");
const expected = {
  "its address": `<link rel="canonical" href="${SITE}/"`,
  "a description": '<meta name="description" content="',
  "a title for shared links": '<meta property="og:title" content="',
  "a picture for shared links": `<meta property="og:image" content="${SITE}/generated/social.png"`,
  "the page's script": '<script type="module"',
  "the page's styles": '<link rel="stylesheet"',
};
for (const [what, markup] of Object.entries(expected)) {
  // Vite keeps attributes as written and may change the space between them.
  if (!page.replace(/\s+/g, " ").includes(markup)) problems.push(`index.html lacks ${what}.`);
}
// Every file the page names: pictures, styles, the script, icons and the social picture.
const named = [...page.matchAll(/\s(?:href|src|srcset|content)="([^"]+)"/g)]
  .flatMap(([, value = ""]) => value.split(","))
  .map((entry) => entry.trim().split(/\s+/)[0] ?? "")
  .map((address) => (address.startsWith(`${SITE}/`) ? address.slice(SITE.length) : address))
  .filter((address) => /^\/[^/].*\.\w+$/.test(address));
for (const path of new Set(named)) {
  if (!existsSync(join(files, path))) problems.push(`index.html names ${path}, which is missing.`);
}
if (named.length === 0) problems.push("index.html names no files.");

if (!read("robots.txt").includes(`Sitemap: ${SITE}/sitemap.xml`)) {
  problems.push("robots.txt doesn't name the sitemap.");
}
if (!read("sitemap.xml").includes(`<loc>${SITE}/</loc>`)) {
  problems.push("sitemap.xml doesn't list the page.");
}

const answers = (path: string) => new RegExp(privacy.src).test(path);
if (!answers("/privacy") || !answers("/privacy/") || answers("/privacy/other") || answers("/")) {
  problems.push("The privacy route doesn't answer exactly /privacy and /privacy/.");
}
if (existsSync(join(output, "builds.json"))) problems.push("The package holds a builds.json.");

if (problems.length > 0) throw new Error(`The package isn't ready:\n${problems.join("\n")}`);
console.log(`Packed ${new Set(named).size} files the page names into ${output}`);
