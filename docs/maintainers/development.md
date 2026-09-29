# Development

Needs Node 24 and pnpm 11. `package.json` lists every script.

```sh
pnpm install
pnpm dev          # the app with hot reload
pnpm fmt:check    # Prettier
pnpm typecheck    # main, preload and shared code, then the renderer
pnpm test         # Vitest
pnpm build        # production bundles in out/
```

## Running the app

Mr. Streamer needs an Xtream Codes subscription to show anything; use your own. Keep its details out of the repository: the gitignored `.local/` folder is the place for private notes and test access.

Streams the player can't decode go through ffmpeg (see [architecture](architecture.md#playback)). Development builds use the `ffmpeg` on your PATH (`brew install ffmpeg`, `apt install ffmpeg` or `winget install Gyan.FFmpeg`); packaged builds use their bundled copy.

Environment variables for testing:

| Variable                  | Effect                                                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MR_STREAMER_FFMPEG`      | The ffmpeg to convert streams with, in development and packaged builds. The tests read it too.                                                                    |
| `MR_STREAMER_UPDATE_FEED` | A GitHub-compatible API to read releases from instead of `https://api.github.com`; see [releasing](releasing.md#testing-updates-before-the-repository-is-public). |

## Installers

Each installer builds on its own system; the [release workflow](releasing.md) builds all of them. The bundled ffmpeg comes first:

```sh
scripts/build-ffmpeg.sh mac-arm64   # or linux-x64, win-x64
pnpm dist:mac                       # or dist:win, dist:linux
```

`scripts/build-ffmpeg.sh` needs a C compiler, make, nasm, pkg-config, git and curl. On Windows, run it in an MSYS2 MINGW64 shell; on Linux it can also cross-compile the Windows build with mingw-w64. It puts the binary and its licences in `vendor/ffmpeg/<target>`, which electron-builder copies into the app. Without it, the app still builds, and streams that need converting report that they can't be played.

A Mac build signs with a Developer ID from your keychain when one exists and notarizes when `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` are set; see [signing](signing.md). Without a Developer ID, `scripts/mac-ad-hoc-sign.ts` seals the app ad hoc, so a downloaded copy opens once through System Settings > Privacy & Security > Open Anyway instead of being called damaged.

## Artwork

- App icons come from `assets/brand/`; `pnpm icons:export` renders `build/icon.*`.
- The DMG window background is `build/dmg-background.png` and its `@2x` twin; `pnpm dmg:background` renders them on a Mac, so the text uses the system font.
