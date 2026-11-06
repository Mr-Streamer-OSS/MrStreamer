## Launch

Run from the repository root with Node 24+ and the pinned pnpm. Prepare once, and rebuild after product changes:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm verify:desktop doctor
pnpm verify:desktop live-tv
```

On Linux without a display, replace the last command with `xvfb-run -a pnpm verify:desktop live-tv`. Use the same prefix for other scenarios. The helper resolves this checkout's Electron executable, starts the built desktop app with a fresh temporary profile and a loopback debugging port, and starts the existing fake IPTV provider and TMDB API. Each invocation is a complete fresh session, including teardown; there is no shared app for later commands to attach to. Readiness means CDP answers, its command line matches the owned profile/port/checkout, and the window loads this checkout's built renderer.

Prerequisites are Electron's downloaded binary, ffmpeg and ffprobe, plus a display or Xvfb on Linux. `pnpm install` may download Electron; `doctor` checks files and tools without downloading it. If the Electron binary is missing after installation, follow [development](../../../../docs/contributing/development.md); do not change host sandbox policy to start the app. The Linux helper uses the repo's documented `--no-sandbox` recipe only for this disposable instance. macOS uses `--use-mock-keychain`. Its playback is silent (`--mute-audio`) unless `FIXTURE_SOUND=1`, as [testing](../../../../docs/contributing/testing.md#sound) says. Native macOS and Windows runs still need verification on those systems.
