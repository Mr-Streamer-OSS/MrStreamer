# Testing

The suite checks what the services promise, through their public functions, against a fake provider. It stays small: each test describes a behaviour a user or the release process depends on.

| File                        | Covers                                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `test/subscription.test.ts` | Logins, M3U links, account states, restarts, removal racing a slow account check, keychain loss       |
| `test/library.test.ts`      | Loading, search, cache after restart, failed, empty and short refreshes, ids across renames           |
| `test/catalogue.test.ts`    | Display names and region grouping                                                                     |
| `test/preferences.test.ts`  | History order and limits, restarts, older files                                                       |
| `test/playback.test.ts`     | The local proxy, one-connection switching, refusals, and what the player receives for each codec clip |
| `test/updates.test.ts`      | Channels, release routing, user-started downloads, restarts, starting fresh and its recovery          |
| `test/release.test.ts`      | Version order, when a nightly is due, which commit a stable release builds, and refused versions      |

`pnpm test` runs them all. The conversion tests need `ffmpeg` and `ffprobe`: they use the ffmpeg on PATH, or `MR_STREAMER_FFMPEG`, and skip without one. CI installs both.

## Fake provider and codec clips

`test/fake-provider.ts` answers like an Xtream Codes panel, with the untidiness of real ones: prefixed names, separator entries, numbers sent as strings, missing logos, one connection at a time. Tests can make catalogue requests fail or change the channels it lists. Its "TEST | Formats and failures" category streams the clips in `test/fixtures`, plus an offline channel.

The clips are generated, never recorded from a real channel. Three seconds of test picture and tone, 128 × 72:

```sh
ffmpeg -f lavfi -i smptebars=size=128x72:rate=25 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 3 \
  <codecs> -f mpegts <name>.mpegts
```

| Clip                                | Codecs                                                                                                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `h264-aac`                          | `-c:v libx264 -preset medium -crf 30 -pix_fmt yuv420p -g 25 -c:a aac -b:a 32k -ac 2`                                                                                             |
| `h264-mp2`, `-mp3`, `-ac3`, `-eac3` | The same video with `-c:a mp2`, `libmp3lame`, `ac3` or `eac3`                                                                                                                    |
| `h264-ac3-dvb`                      | As `h264-ac3`, plus `-mpegts_flags system_b` for DVB signalling                                                                                                                  |
| `hevc-aac`, `hevc10-aac`            | `-c:v libx265 -preset medium -crf 30`, the second with `-pix_fmt yuv420p10le -profile:v main10`                                                                                  |
| `mpeg2-mp2`                         | `-c:v mpeg2video -q:v 10 -c:a mp2 -b:a 64k`                                                                                                                                      |
| `h264-open-gop-joined`              | Four seconds of `testsrc2` with `-x264-params keyint=25:min-keyint=25:open-gop=1:bframes=3:scenecut=0`, cut 45% in on a 188-byte boundary, like joining a broadcast mid-sequence |
| `h264-damaged`                      | `h264-aac` with the payload of two video packets a third of the way in overwritten, like lost packets                                                                            |

## Packaged app

`test/e2e/packaged-app.ts` starts a built app with a throwaway profile, connects it to the fake provider through the login form, and plays a channel that passes straight through and one the bundled ffmpeg converts. It passes when both show a moving picture with decoded sound.

```sh
node test/e2e/packaged-app.ts "/Applications/Mr. Streamer.app/Contents/MacOS/Mr. Streamer" -- --use-mock-keychain
node test/e2e/packaged-app.ts "$LOCALAPPDATA\Programs\mrstreamer\Mr. Streamer.exe"
xvfb-run -a node test/e2e/packaged-app.ts "/opt/Mr. Streamer/mrstreamer" -- --no-sandbox
```

`--use-mock-keychain` keeps a macOS run away from the real Keychain.

## CI

`.github/workflows/ci.yml` runs on every pull request and push to `main`, in two jobs:

- **Check:** unused files, exports and dependencies (`pnpm knip`), lint (`pnpm lint`), format, typecheck and the production build.
- **Test:** the suite, with the system ffmpeg for the conversion tests.

The [release workflow](releasing.md) runs both jobs on the exact commit it releases, next to the packaged-app test on every installed package. CI needs no secrets, so pull requests from forks run it too.
