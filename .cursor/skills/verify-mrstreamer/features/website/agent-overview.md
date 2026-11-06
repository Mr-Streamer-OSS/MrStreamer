# Agent overview

## Agent overview

`/llms.txt` serves the static Markdown overview in `apps/marketing/public/llms.txt`. After `pnpm build:marketing`, request it from the owned Vite preview and check HTTP 200, `text/plain` with UTF-8, an H1, blockquote summary and Markdown links, without page JavaScript. Check internal destinations against the built canonical pages and product claims against the public guides. Inspect `.vercel/output/config.json` and `.vercel/output/static/llms.txt` under `apps/marketing` for the same plain-text response and content. HTTP and package proof suffice for this text route; screenshots add nothing. Production availability needs a separate readback after authorized publication.
