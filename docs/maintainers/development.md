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

Streams the player can't decode go through ffmpeg (see [architecture](architecture.md#playback)). Development builds use the `ffmpeg` on your PATH (`brew install ffmpeg`, `apt install ffmpeg` or `winget install Gyan.FFmpeg`); packaged builds use their bundled copy.

Environment variables for testing:

| Variable                  | Effect                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MR_STREAMER_FFMPEG`      | The ffmpeg to convert streams with, in development and packaged builds. The tests read it too.                                                         |
| `MR_STREAMER_UPDATE_FEED` | A GitHub-compatible API to read releases from instead of `https://api.github.com`; see [releasing](releasing.md#testing-updates-against-another-feed). |

## Installers

Each installer builds on its own system; the [release workflow](releasing.md) builds all of them. The bundled ffmpeg comes first:

```sh
apps/desktop/scripts/build-ffmpeg.sh mac-arm64   # or linux-x64, win-x64
pnpm dist:mac                                    # or dist:win, dist:linux; installers land in apps/desktop/dist
```

`build-ffmpeg.sh` needs a C compiler, make, nasm, pkg-config, git and curl. On Windows, run it in an MSYS2 MINGW64 shell; on Linux it can also cross-compile the Windows build with mingw-w64. It puts the binary and its licences in `apps/desktop/vendor/ffmpeg/<target>`, which electron-builder copies into the app. Without it, the app still builds, and streams that need converting report that they can't be played.

A Mac build signs with a Developer ID from your keychain when one exists and notarizes when `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` are set; see [signing](signing.md). Without a Developer ID, `apps/desktop/scripts/mac-ad-hoc-sign.ts` seals the app ad hoc, so a downloaded copy opens once through System Settings > Privacy & Security > Open Anyway instead of being called damaged.

## Artwork

- App icons come from `apps/desktop/assets/brand/`; `pnpm --filter mrstreamer icons:export` renders `apps/desktop/build/icon.*`.
- The DMG window background is `apps/desktop/build/dmg-background.png` and its `@2x` twin; `pnpm --filter mrstreamer dmg:background` renders them on a Mac, so the text uses the system font.
