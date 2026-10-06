// Builds the website's three pages, and gives both local servers the addresses Vercel answers
// (scripts/package-vercel.ts).
//
// - index.html, privacy/index.html and 404.html are built into dist/. The privacy page's text is
//   docs/privacy.md, rendered into the page here, so the policy has one source and reads without
//   scripts.
// - The home page gets the script that names the visitor's system in its head (src/system.ts),
//   and its download links point at the current stable release's installers, once GitHub has
//   answered for each (src/downloads.ts). The build never fails over them: unanswered, the links
//   stay on the Releases page.
// - `vite` and `vite preview` answer / and /privacy with their pages, and any address with no
//   page or file with 404.html and status 404.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Marked } from "marked";
import { defineConfig, type Connect } from "vite";
import { installers, verifiedDownloads, writeDownloads, type Downloads } from "./src/downloads.ts";
import { systemOf } from "./src/system.ts";

const root = import.meta.dirname;

/** Each address and the page that answers it. */
const PAGES = new Map([
  ["/", "index.html"],
  ["/privacy", "privacy/index.html"],
  ["/privacy/", "privacy/index.html"],
]);
/** The page for every other address, answered with status 404. */
const MISSING = "404.html";
/** Where privacy/index.html takes the policy. */
const POLICY = "<!-- privacy-policy -->";
/** Where index.html takes the script that names the visitor's system. */
const SYSTEM = "<!-- system -->";
/** What marks index.html's installer links. */
const INSTALLER = "data-installer=";

const markdown = new Marked({
  renderer: {
    // An id on each heading, so a link can point at a section.
    heading({ text, tokens, depth }) {
      const id = text
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-");
      return `<h${depth} id="${id}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
    },
  },
});

/**
 * `systemOf` as the page runs it: its own text, called before the page paints. A system it can't
 * name leaves <html> without data-os, and the hero on Downloads.
 */
const systemScript = `<script>{const os=(${systemOf})(navigator);if(os)document.documentElement.dataset.os=os}</script>`;

/** Asked once a run: the development server builds the page on every request. */
let downloads: Promise<Downloads | null> | undefined;

/**
 * The current stable release's installers, with a line saying what the page links. When some are
 * unknown the line is a warning, which GitHub Actions shows on the run, and the page still builds.
 */
async function resolveDownloads(): Promise<Downloads | null> {
  const found = await verifiedDownloads();
  const missing = installers.filter((installer) => !found?.installers.includes(installer));
  console.log(
    found && missing.length === 0
      ? `Download links: ${found.version}, every installer.`
      : `::warning::Download links: ${found ? `GitHub didn't answer for ${found.version}'s ${missing.join(", ")}` : "the update feed gave no stable release"}. The Releases page is linked instead.`,
  );
  return found;
}

/**
 * Answers a request the server's own files left: a page at its address, 404.html with status 404
 * at any other. `read` returns a page's HTML by file name.
 */
function pages(read: (file: string) => string | Promise<string>): Connect.NextHandleFunction {
  return async (req, res, next) => {
    const [path = "/"] = (req.url ?? "/").split("?");
    const file = PAGES.get(path);
    try {
      const html = await read(file ?? MISSING);
      res.statusCode = file ? 200 : 404;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(html);
    } catch (error) {
      next(error);
    }
  };
}

export default defineConfig({
  // No page handling of Vite's own: `pages` answers every address.
  appType: "custom",
  build: {
    rollupOptions: {
      input: [...new Set(PAGES.values()), MISSING].map((file) => join(root, file)),
    },
  },
  plugins: [
    {
      name: "marketing-pages",
      async transformIndexHtml(html) {
        const page = html
          .replace(POLICY, () =>
            markdown.parse(readFileSync(join(root, "../../docs/privacy.md"), "utf8"), {
              async: false,
            }),
          )
          .replace(SYSTEM, () => systemScript);
        if (!page.includes(INSTALLER)) return page;
        const found = await (downloads ??= resolveDownloads());
        return found ? writeDownloads(page, found) : page;
      },
      configureServer: (server) => () =>
        server.middlewares.use(
          pages((file) =>
            server.transformIndexHtml(`/${file}`, readFileSync(join(root, file), "utf8")),
          ),
        ),
      configurePreviewServer(server) {
        const answer = pages((file) => readFileSync(join(root, "dist", file), "utf8"));
        // Ahead of the built files, where 404.html would answer 200 as one of them.
        server.middlewares.use((req, res, next) =>
          req.url?.split("?")[0] === `/${MISSING}` ? answer(req, res, next) : next(),
        );
        return () => server.middlewares.use(answer);
      },
    },
  ],
});
