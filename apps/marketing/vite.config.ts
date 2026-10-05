// Builds the website's three pages, and gives both local servers the addresses Vercel answers
// (scripts/package-vercel.ts).
//
// - index.html, privacy/index.html and 404.html are built into dist/. The privacy page's text is
//   docs/privacy.md, rendered into the page here, so the policy has one source and reads without
//   scripts.
// - `vite` and `vite preview` answer / and /privacy with their pages, and any address with no
//   page or file with 404.html and status 404.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Marked } from "marked";
import { defineConfig, type Connect } from "vite";

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
      transformIndexHtml: (html) =>
        html.replace(POLICY, () =>
          markdown.parse(readFileSync(join(root, "../../docs/privacy.md"), "utf8"), {
            async: false,
          }),
        ),
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
