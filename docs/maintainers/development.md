# Development

Needs Node 24 and pnpm 11. `package.json` lists every script.

```sh
pnpm install
pnpm dev          # the app with hot reload
pnpm knip         # unused files, exports and dependencies
pnpm lint         # oxlint
pnpm fmt:check    # Prettier
pnpm typecheck    # main, preload and shared code, then the renderer
pnpm test         # Vitest
pnpm build        # production bundles in apps/desktop/out/
```

The repository is a pnpm workspace: the app is `apps/desktop`, shared contracts and rules are in `packages/`; [architecture](architecture.md) shows the layout. The scripts above run from the root. If `pnpm dev` reports that Electron failed to install, as a fresh install from pnpm's store can leave it, run `node node_modules/electron/install.js`.

## Running the app

Mr. Streamer needs an Xtream Codes subscription to show anything; use your own. Keep its details out of the repository: the gitignored `.local/` folder is the place for private notes and test access.

Streams the player can't decode go through ffmpeg, and every movie and episode goes through ffprobe and ffmpeg (see [architecture](architecture.md#playback)). Development builds use the `ffmpeg` and `ffprobe` on your PATH (`brew install ffmpeg`, `apt install ffmpeg` or `winget install Gyan.FFmpeg`); packaged builds use their bundled copies.

Environment variables for testing:

| Variable                    | Effect                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `MR_STREAMER_FFMPEG`        | The ffmpeg to convert streams with, in development and packaged builds; its ffprobe must sit beside it. The tests read it too.  |
| `MR_STREAMER_UPDATE_FEED`   | The update feed to read instead of the published one; see [releasing](releasing.md#testing-updates-against-another-feed).       |
| `MR_STREAMER_UPDATE_API`    | A GitHub-compatible API for when the feed is missing, instead of `https://api.github.com`.                                      |
| `MR_STREAMER_UPDATE_CHECKS` | `off` stops the automatic update checks; checking from Settings still works. The packaged-app test and the measurements set it. |

## Installers

Each installer builds on its own system; the [release workflow](releasing.md) builds all of them. The bundled ffmpeg comes first:

```sh
apps/desktop/scripts/build-ffmpeg.sh mac-arm64   # or linux-x64, win-x64
pnpm dist:mac                                    # or dist:win, dist:linux; installers land in apps/desktop/dist
```

`build-ffmpeg.sh` needs a C compiler, make, nasm, pkg-config, git and curl. On Windows, run it in an MSYS2 MINGW64 shell; on Linux it can also cross-compile the Windows build with mingw-w64. It puts `ffmpeg`, `ffprobe` and their licences in `apps/desktop/vendor/ffmpeg/<target>`, which electron-builder copies into the app. Without them, the app still builds, but streams that need converting, and every movie and episode, report that they can't be played.

A Mac build signs with a Developer ID from your keychain when one exists and notarizes when `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` are set; see [signing](signing.md). Without a Developer ID, `apps/desktop/scripts/mac-ad-hoc-sign.ts` seals the app ad hoc, so a downloaded copy opens once through System Settings > Privacy & Security > Open Anyway instead of being called damaged.

## Third-party notices

Settings > About lists what the installers ship and under which licences. `pnpm build` writes the list to `apps/desktop/out/licences/third-party.json`, which electron-builder packages with the rest of `out/`. `apps/desktop/scripts/licences.ts` takes the packages whose modules ended up in the main, preload and renderer bundles, whether dependencies or devDependencies, reads their LICENSE, NOTICE and COPYING files, and adds what `apps/desktop/licences.config.json` describes:

- `packages`: packages the installers carry without a bundled module. Electron, and Tailwind for the base styles in the CSS.
- `overrides`: help for a package, with a `why`. `licence` for one that declares none, `files` to show instead of its own, or `standardText` to add the licence's standard text from `apps/desktop/licences/standard`, for a package without a licence file (with the author from its package.json) or with a notice that only refers to its licence.
- `embedded`: packages built into another package's prebuilt files and not installed, which the source maps reveal, under that package's `name@version`. Upgrading it fails the build until someone checks the entry and renames it.
- `components`: Chromium, Node.js, FFmpeg and x264. `{app}` is the version being built, `{FFMPEG_VERSION}` and `{X264_COMMIT}` come from `build-ffmpeg.sh`, and the app fills `{chrome}` and `{node}` from the Electron it runs on.

The build fails and lists every problem when a package declares no licence, has no licence file and no override, refers to Apache-2.0 or the GPL without including its text, carries a package that is neither installed nor under `embedded`, or uses a licence missing from `COMPATIBLE` in `scripts/licences.ts`. Read a licence's terms before adding it there.

Chromium's credits, which hold Node.js's licence too, are 20 MB of HTML from Electron's download: next to the executable on Linux and Windows, in the app's Resources on macOS, where `electron-builder.yml` copies them. The main process turns them into plain text when the UI asks for Chromium or Node.js. `pnpm dev` serves the renderer instead of bundling it, so development shows the notices of the last `pnpm build`.

## Artwork

- App icons come from `apps/desktop/assets/brand/`; `pnpm --filter mrstreamer icons:export` renders `apps/desktop/build/icon.*`.
- The DMG window background is `apps/desktop/build/dmg-background.png` and its `@2x` twin; `pnpm --filter mrstreamer dmg:background` renders them on a Mac, so the text uses the system font.
