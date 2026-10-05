// Packs the built site as Vercel's Build Output API, version 3, in .vercel/output/, and checks
// the package before anything deploys it: `vercel deploy --prebuilt` uploads exactly this folder.
//
//   node scripts/package-vercel.ts    (after `vite build`)
//
// - static/: everything in dist/.
// - config.json: /privacy and /privacy/ answer the privacy page, which the app and the Store
//   listing link to. An address with no page or file answers 404.html with status 404, and so
//   does /404.html itself. No builds.json: without one the CLI deploys to the target it is told,
//   where a builds.json naming a preview would win.
//
// Fails, listing every problem, when:
// - a page names a file the package lacks, or has no script or styles
// - the home or privacy page lacks its address, description or social picture, or the sitemap
//   doesn't list it
// - the privacy page doesn't hold the whole policy
// - search engines could list 404.html
// - robots.txt doesn't name the sitemap, or a route answers with a missing page
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SITE = "https://mrstreamer.app";
/** The pages search engines list, by address. */
const LISTED = { "/": "index.html", "/privacy": "privacy/index.html" };

const root = join(import.meta.dirname, "..");
const output = join(root, ".vercel/output");
const files = join(output, "static");

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
cpSync(join(root, "dist"), files, { recursive: true });
// Vercel matches src against the path without its query. The routes above "filesystem" answer
// before the package's files, the one below it after them.
const missing = { status: 404, dest: "/404.html" };
const routes = [
  { src: "^/privacy/?$", dest: `/${LISTED["/privacy"]}` },
  { src: "^/404\\.html$", ...missing },
  { handle: "filesystem" },
  { src: "^/.*$", ...missing },
];
writeFileSync(join(output, "config.json"), `${JSON.stringify({ version: 3, routes }, null, 2)}\n`);

const problems: string[] = [];
const read = (name: string) =>
  existsSync(join(files, name)) ? readFileSync(join(files, name), "utf8") : "";

const everyPage = {
  "the site's script": '<script type="module"',
  "the site's styles": '<link rel="stylesheet"',
};
const packed = new Set<string>();
/** Checks that a page holds each piece of markup and that every file it names is packed. */
function check(name: string, expected: Record<string, string>) {
  const page = read(name);
  for (const [what, markup] of Object.entries({ ...everyPage, ...expected })) {
    // Vite keeps attributes as written and may change the space between them.
    if (!page.replace(/\s+/g, " ").includes(markup)) problems.push(`${name} lacks ${what}.`);
  }
  // Every file the page names: pictures, styles, the script, icons and the social picture.
  const named = [...page.matchAll(/\s(?:href|src|srcset|content)="([^"]+)"/g)]
    .flatMap(([, value = ""]) => value.split(","))
    .map((entry) => entry.trim().split(/\s+/)[0] ?? "")
    .map((address) => (address.startsWith(`${SITE}/`) ? address.slice(SITE.length) : address))
    .filter((address) => /^\/[^/].*\.\w+$/.test(address));
  for (const path of new Set(named)) {
    packed.add(path);
    if (!existsSync(join(files, path))) problems.push(`${name} names ${path}, which is missing.`);
  }
  if (named.length === 0) problems.push(`${name} names no files.`);
}

const sitemap = read("sitemap.xml");
for (const [address, name] of Object.entries(LISTED)) {
  check(name, {
    "its address": `<link rel="canonical" href="${SITE}${address}"`,
    "a description": '<meta name="description" content="',
    "a title for shared links": '<meta property="og:title" content="',
    "a picture for shared links": `<meta property="og:image" content="${SITE}/generated/social.png"`,
  });
  if (!sitemap.includes(`<loc>${SITE}${address}</loc>`)) {
    problems.push(`sitemap.xml doesn't list ${address}.`);
  }
}
check("404.html", {
  "the tag that keeps it out of search results": '<meta name="robots" content="noindex"',
});

// The privacy page is docs/privacy.md, rendered: each heading there is a heading here.
const headings = readFileSync(join(root, "../../docs/privacy.md"), "utf8").match(/^#+ /gm) ?? [];
const rendered = read(LISTED["/privacy"]).match(/<h[1-6][ >]/g) ?? [];
if (headings.length === 0 || rendered.length !== headings.length) {
  problems.push(`${LISTED["/privacy"]} doesn't hold the whole privacy policy.`);
}

if (!read("robots.txt").includes(`Sitemap: ${SITE}/sitemap.xml`)) {
  problems.push("robots.txt doesn't name the sitemap.");
}
for (const dest of new Set(routes.flatMap(({ dest }) => dest ?? []))) {
  if (!existsSync(join(files, dest))) {
    problems.push(`A route answers with ${dest}, which is missing.`);
  }
}
if (existsSync(join(output, "builds.json"))) problems.push("The package holds a builds.json.");

if (problems.length > 0) throw new Error(`The package isn't ready:\n${problems.join("\n")}`);
console.log(`Packed the pages and the ${packed.size} files they name into ${output}`);
