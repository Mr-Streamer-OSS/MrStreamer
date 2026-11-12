## Drive

```sh
pnpm verify:desktop --help
pnpm verify:desktop subscriptions
pnpm verify:desktop remove-during-guide
pnpm verify:desktop moved-guide
pnpm verify:desktop live-tv
pnpm verify:desktop live-names
pnpm verify:desktop picture-sound
pnpm verify:desktop guides
pnpm verify:desktop guide-labels
pnpm verify:desktop catch-up
pnpm verify:desktop catch-up-hls
pnpm verify:desktop guide-grid
pnpm verify:desktop reminders
pnpm verify:desktop titles
pnpm verify:desktop details-back
pnpm verify:desktop title-controls
pnpm verify:desktop watchlist
pnpm verify:desktop poster-grid
pnpm verify:desktop downloads
pnpm verify:desktop downloads-queue
pnpm verify:desktop downloads-series
pnpm verify:desktop language
pnpm verify:desktop custom-lists
pnpm verify:desktop custom-lists-sources
pnpm verify:desktop custom-lists-round-trip <executable>
```

`custom-lists-round-trip` takes the executable of a prior release's packaged app, such as an extracted 0.0.19 AppImage's `squashfs-root/mrstreamer`, and starts it on the same owned profile between runs of this build; its live doctor checks that executable and its renderer instead of this checkout's.

The executable [control helper](../scripts/control.ts) reuses `apps/desktop/test/e2e/app.ts` for CDP and the repo's provider/TMDB fixtures. It uses DOM handles from real ARIA labels, button text and poster titles to send pointer/key/text input to the window. Login, navigation and saving go through the UI. On Linux every scenario starts on an English system (`LANGUAGE`/`LANG`), so the app's System default reads in English; `language` restarts on others. Read-only DOM observations and fixture request counters establish results; invoking an IPC setter or modifying the database cannot substitute for the user path.

These scenarios are baseline proofs, not exhaustive acceptance. Each feature entry names additional supported paths and the existing deeper harness. For a changed path outside the baseline, drive it through the existing harness or extend this helper with a focused UI scenario and retained evidence. For a running Electron desktop window use its repo CDP harness; for a web surface use T3's collaborative browser. For website proof, follow [the website entry](../features/website.md). Prefer T3 collaborative preview for browser driving: status, open, snapshot and focused interactions. If tools are absent or opening the browser reports it unavailable, the [Website fallback](website.md) uses the same pinned Electron/CDP machinery.
