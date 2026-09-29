# Mr. Streamer

A cinematic desktop player for your existing IPTV subscriptions. Electron app for macOS (Apple Silicon), Windows 11 (x64) and Linux (x64). Your login, channel list and preferences stay on the device.

Status: slice 01 (install and watch live TV) is built and in acceptance. It connects one Xtream Codes subscription, lets you browse and search its live channels, and plays them. The Mac build passed Wout's test. The Windows installer builds on Linux and passes the viewing workflow under Wine; it still needs a run on a real Windows PC. Linux packages are new and pass the same workflow on a headless Ubuntu 24.04 machine.

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

| Platform             | Command                             | Output                                                                                           |
| -------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| macOS, Apple Silicon | `pnpm dist:mac` on a Mac            | `dist/Mr-Streamer-<version>-mac-arm64.dmg`                                                       |
| Windows 11, x64      | `pnpm dist:win` on any of the three | `dist/Mr-Streamer-<version>-win-x64-setup.exe`                                                   |
| Linux, x64           | `pnpm dist:linux` on Linux          | `dist/Mr-Streamer-<version>-linux-x86_64.AppImage`, `dist/Mr-Streamer-<version>-linux-amd64.deb` |

electron-builder needs Wine to build the Windows installer on Linux, and the Wine it downloads itself has no Windows DLLs. So on Linux `pnpm dist:win` downloads a pinned, checksummed standalone Wine 11 into `~/.cache/mr-streamer` and sets it up once (about a minute). See `scripts/dist-win.ts`.

The Mac build signs with a Developer ID certificate from your login keychain when there is one, and notarizes when `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` are set. The Windows installer is unsigned for now: the first run shows SmartScreen, where **More info**, then **Run anyway** continues.

Without a Developer ID, `scripts/mac-ad-hoc-sign.ts` seals the Mac app with an ad hoc signature, and a downloaded copy opens once through **System Settings > Privacy & Security > Open Anyway**. Without that seal macOS would call the app damaged. Each ad hoc build has a new signature, and macOS keeps it from the Keychain key an older build created. After such an update the app asks for the password again; if the Keychain still refuses, delete "Mr. Streamer Safe Storage" in Keychain Access and reopen the app. A Developer ID signature keeps access across updates.

On Linux the password key lives in the desktop keyring (GNOME Keyring or KWallet). Without one, the app falls back to Chromium's fixed-key encryption, as Chromium does for its own passwords: the login still saves, but other programs running as you can read it. The deb installs an AppArmor profile so Chromium's sandbox works on Ubuntu 24.04. The AppImage needs FUSE 2 there (`sudo apt install libfuse2t64`), or runs with `--appimage-extract-and-run`. Linux Chromium plays H.264 and AAC; HEVC, AC-3 and MP2 channels show "Can't play this channel".

App icons come from `assets/brand/`. After changing the artwork, run `pnpm icons:export`.

### Testing the Windows build on Linux

The installed Windows app runs under the same Wine, in a separate prefix, on a virtual display:

```sh
W=~/.cache/mr-streamer/wine-11.0-amd64-wow64
export WINEPREFIX=~/.cache/mr-streamer-wintest/prefix WINEDEBUG=-all
$W/bin/wine wineboot --init
# The installer asks PowerShell whether the app is running, and Wine's PowerShell is a stub that
# always says yes. Put a program that exits 1 in its place, in both system folders, and load it.
for dir in system32 syswow64; do cp "$WINEPREFIX/drive_c/windows/$dir/hostname.exe" "$WINEPREFIX/drive_c/windows/$dir/WindowsPowerShell/v1.0/powershell.exe"; done
WINEDLLOVERRIDES="powershell.exe=n" xvfb-run -a $W/bin/wine dist/Mr-Streamer-<version>-win-x64-setup.exe /S
WINEDLLOVERRIDES="winealsa.drv,winepulse.drv=d" xvfb-run -a $W/bin/wine "C:\\users\\$USER\\AppData\\Local\\Programs\\mr-streamer\\Mr. Streamer.exe" --no-sandbox --disable-gpu --remote-debugging-port=9224
```

With sound drivers disabled Chromium uses its silent audio output, so playback does not wait on a sound device. The first channel after launch can still fail while Wine starts audio; the next one plays.

## Layout

```
src/shared     Contracts between the UI and the main process: IPC schemas, library model, errors
src/main       Electron main process
  providers    Provider adapters that report a provider's catalogue as it is (Xtream Codes)
  catalogue    Display names and region grouping, the same rules for every provider
  services     Subscription, live library, stream proxy, preferences
  platform     Keychain, DPAPI or keyring backed secrets, and atomic JSON files
src/preload    The typed bridge exposed to the UI
src/renderer   React UI; player/ holds the playback engines and the player controller
scripts        Icon export, the Windows build with its Wine, and the Mac ad hoc signing hook
tools          Mock provider and the subscription probe
test           Service and catalogue tests
```

The UI never sees provider URLs or passwords. The main process proxies streams through a random-token URL on `127.0.0.1` and closes the previous stream before it opens the next one.

## License

GPL-3.0. See [LICENSE](LICENSE).
