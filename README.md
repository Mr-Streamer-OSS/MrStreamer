# Mr. Streamer

A cinematic desktop player for your existing IPTV subscriptions. Electron app for macOS (Apple Silicon) and Windows 11 (x64). Your login, channel list and preferences stay on the device.

Status: slice 01 (install and watch live TV) is in progress. It connects one Xtream Codes subscription, lets you browse and search its live channels, and plays them.

## Develop

Needs Node 24 and pnpm 11.

```sh
pnpm install
pnpm dev          # app with hot reload
pnpm test         # service tests against the mock provider
pnpm typecheck
```

### Mock provider

`pnpm mock:provider` runs a local Xtream Codes compatible provider with 12,000 channels on `http://127.0.0.1:7811` (login `demo` / `demo`). It allows one connection at a time, like most real subscriptions. The category `TEST | Streams and failures` holds channels for the cases the player has to handle:

| Channel                                                             | What it sends                    |
| ------------------------------------------------------------------- | -------------------------------- |
| H.264 + AAC, H.264 + MP2, H.264 + AC-3, HEVC + AAC, MPEG-2 SD + MP2 | Live MPEG-TS in that codec mix   |
| Offline                                                             | HTTP 404                         |
| Slow start                                                          | Data after 6 seconds             |
| Drops after 20 s                                                    | Closes the connection mid-stream |

Streams need `ffmpeg` on your PATH (`brew install ffmpeg`, or `winget install Gyan.FFmpeg`). `--null-streams` skips ffmpeg and sends empty MPEG-TS packets.

### Probing a real subscription

Put the login in `.local/subscription.json`. The `.local/` folder is gitignored.

```json
{ "server": "http://line.example.tv:8080", "username": "…", "password": "…" }
```

`node tools/probe-provider.ts --streams 6` prints the account limits, catalogue size and the codecs of a few live streams (needs `ffprobe`). Each stream probe uses one of your provider connections.

## Build installers

| Platform             | Command                             | Output                                         |
| -------------------- | ----------------------------------- | ---------------------------------------------- |
| macOS, Apple Silicon | `pnpm dist:mac` on a Mac            | `dist/Mr-Streamer-<version>-mac-arm64.dmg`     |
| Windows 11, x64      | `pnpm dist:win` on Windows or a Mac | `dist/Mr-Streamer-<version>-win-x64-setup.exe` |

On Linux the Windows build stops after `dist/win-unpacked`, because the installer step needs Wine.

The Mac build signs with a Developer ID certificate from your login keychain when there is one, and notarizes when `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` are set. The Windows installer is unsigned for now: the first run shows SmartScreen, where **More info**, then **Run anyway** continues. A downloaded unsigned Mac build opens once through **System Settings > Privacy & Security > Open Anyway**.

App icons come from `assets/brand/`. After changing the artwork, run `pnpm icons:export`.

## Layout

```
src/shared     Contracts between the UI and the main process: IPC schemas, library model, errors
src/main       Electron main process
  providers    Provider adapters that turn provider APIs into the library model (Xtream Codes)
  services     Subscription, live library, stream proxy, preferences
  platform     Keychain/DPAPI-backed secrets and atomic JSON files
src/preload    The typed bridge exposed to the UI
src/renderer   React UI; player/ holds the playback engines and the player controller
tools          Mock provider and the subscription probe
test           Service tests
```

The UI never sees provider URLs or passwords. The main process proxies streams through a random-token URL on `127.0.0.1` and closes the previous stream before it opens the next one.

## License

GPL-3.0. See [LICENSE](LICENSE).
