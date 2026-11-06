## Native macOS on the Mac mini

Use the installed `mac-mini` skill for native Mac checks. It is the access and control workflow; reuse its `onmac`, `cua-driver` and capture guidance. Start with `onmac check`, then run from this MR Streamer checkout:

```sh
onmac run -- pnpm install --frozen-lockfile
onmac run -- pnpm build
onmac run -- pnpm verify:desktop doctor
onmac run -- pnpm verify:desktop live-tv
```

Other desktop scenarios use the same command. Install the Mac's own dependencies; Linux `node_modules` is not a Mac build. The helper keeps its temporary profile and mock keychain. For native controls, audible output, AirPlay or Safari-specific website behavior, use the Mac mini skill's installed window-control tools against your own instance. Keep provider logins off the rented Mac. When signing is authorized, use the Mac mini skill's managed signing setup. Pull retained `.local/verification/` evidence with `onmac pull` before scoped cleanup. Leave other agents' windows and checkouts intact, and report an unavailable Mac or missing GUI permission as a blocked native check. These recipes describe capability; claim macOS coverage only after an actual Mac run.
