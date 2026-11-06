## Website launch and proof

Build locally from the repo root:

```sh
pnpm build:marketing
pnpm verify:website --help
pnpm verify:website
```

On headless Linux: `xvfb-run -a pnpm verify:website`. The executable [website helper](../scripts/website.ts) starts the existing Vite preview on an OS-selected loopback port and an isolated browser/profile. Its live doctor checks both child processes, browser/profile/port identity and the local site origin before interaction and after navigation. Each invocation drives Home at 1280px and 390px, then keeps the 390px viewport while clicking FAQ, the Downloads guide, Guides, Subscriptions, Downloads, Releases and Privacy, checking each route's layout, rendered heading and HTTP status. It then reads FAQ, opens its Can I download? question with the pointer and follows the Downloads guide link inside it, also with page scripts disabled. It validates all four installer destinations or their GitHub Releases fallback, plus the Microsoft Store product. Unknown routes must answer 404. Screenshots, accessibility trees, actions, served-build hash, route metadata, installer/Store links and teardown results remain in `.local/verification/website-<unique>/`.

The build reads public GitHub releases and verifies installer links; it writes ignored local output, never publishes Vercel. The fallback browser blocks external requests, so proof records build-time links rather than live feed refresh or actual installer downloads. For an interactive collaborative preview, start the documented `pnpm preview:marketing` with a unique strict port, bind to the owned local server and follow the website feature entry; retain actions and screenshots, then stop that owned server. A tools failure grants no host sandbox-setup or production-deployment authority.
