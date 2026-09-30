# Testing

The suite checks what the services promise, through their public functions, against a fake provider. It stays small: each test describes a behaviour a user or the release process depends on.

| File                                     | Covers                                                                                                                                                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/test/subscription.test.ts` | Logins, M3U links, account states, restarts, removal racing a slow account check, keychain loss                                                                                                                                         |
| `apps/desktop/test/library.test.ts`      | Loading, search, cache after restart, caches saved before guide ids, failed, empty and short refreshes, ids across renames                                                                                                              |
| `packages/core/test/catalogue.test.ts`   | Display names and region grouping                                                                                                                                                                                                       |
| `apps/desktop/test/preferences.test.ts`  | Partial updates, forgetting on account changes, restarts, keys of newer versions, files that still carry favourites and history                                                                                                         |
| `apps/desktop/test/diagnostics.test.ts`  | What the log records for a session, without addresses, logins or channel names; rotation                                                                                                                                                |
| `apps/desktop/test/viewing.test.ts`      | Favourites and history order across restarts, commands sent again, accounts, change notices, the one-time import from `preferences.json`, rebuilding from events, a database that can't open                                            |
| `apps/desktop/test/guide.test.ts`        | Now and next, the rest of the day, untidy XMLTV in small pieces, guide ids shared by unrelated channels, programme search, restarts from disk, six-hour refreshes and failed ones, answering before the first download, account changes |
| `apps/desktop/test/playback.test.ts`     | The local proxy, one-connection switching, quitting, refusals, and what the player receives for each codec clip                                                                                                                         |
| `apps/desktop/test/updates.test.ts`      | Channels, release routing, going back to Stable, downloads and retries, channel switches, checks answering late, refused installs, Stable behind a full page of nightlies                                                               |
| `apps/desktop/test/installer.test.ts`    | The electron-updater adapter: cancelling at every step, refused installs                                                                                                                                                                |
| `test/release.test.ts`                   | Version order, when a nightly is due, which commit a stable release builds, release notes, and refused versions                                                                                                                         |

`pnpm test` runs them all. The conversion tests need `ffmpeg` and `ffprobe`: they use the ffmpeg on PATH, or `MR_STREAMER_FFMPEG`, and skip without one. CI installs both.

## Fake provider and codec clips

`apps/desktop/test/fake-provider.ts` answers like an Xtream Codes panel, with the untidiness of real ones: prefixed names, separator entries, numbers sent as strings, missing logos, one connection at a time. Tests can make catalogue requests fail or change the channels it lists. About half its channels have a guide id, shared by variants of one channel, and `xmltv.php` serves half-hour programmes around the current time. Tests can replace that document, fail it, hold it open or send it in pieces of a few bytes, and count guide and stream requests. Its "TEST | Formats and failures" category streams the clips in `test/fixtures`, plus an offline channel.

The clips in `apps/desktop/test/fixtures` are generated, never recorded from a real channel. Three seconds of test picture and tone, 128 × 72:

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

`apps/desktop/test/e2e/packaged-app.ts` starts a built app with a throwaway profile, connects it to the fake provider through the login form, and plays a channel that passes straight through and one the bundled ffmpeg converts. Then it leaves Watch for Home and watches again from there. It passes when both channels show a moving picture with decoded sound, and Home plays the same stream muted while Watch plays it with sound, without another request to the provider.

```sh
node apps/desktop/test/e2e/packaged-app.ts "/Applications/Mr. Streamer.app/Contents/MacOS/Mr. Streamer" -- --use-mock-keychain
node apps/desktop/test/e2e/packaged-app.ts "$LOCALAPPDATA\Programs\mrstreamer\Mr. Streamer.exe"
xvfb-run -a node apps/desktop/test/e2e/packaged-app.ts "/opt/Mr. Streamer/mrstreamer" -- --no-sandbox
```

`--use-mock-keychain` keeps a macOS run away from the real Keychain. Without FUSE, run an AppImage with `APPIMAGE_EXTRACT_AND_RUN=1` in the environment. A development build runs it too, after `pnpm build`: `xvfb-run -a node apps/desktop/test/e2e/packaged-app.ts node_modules/electron/dist/electron -- --no-sandbox "$PWD"`.

## App measurements

`node apps/desktop/test/e2e/measure-app.ts [--json results.json] <app executable> [-- app arguments]` drives a built app against the fake provider at the size of a large subscription: 13,000 channels, about 2,000 with a guide, and a continuous 720p stream that ffmpeg encodes as it plays. It prints medians for cold start, time to picture, channel switch, opening the guide, search, idle CPU and memory on Home with and without the muted preview, and the installed size. Slice handoffs record its numbers for comparison. It shares its DevTools client and login with the packaged-app test (`apps/desktop/test/e2e/app.ts`). `--json` also writes every run of every measure.

`node apps/desktop/test/e2e/compare-builds.ts [--rounds 2] <baseline> <candidate> [-- app arguments]` measures two builds on one machine, alternating which goes first each round, and prints each measure's median before and after with the change. A machine that drifts during the runs affects both builds alike, which is what makes shared machines usable. The release workflow runs it for every nightly and dry run on macOS and Linux, against the last nightly, and puts the table in the run summary. Changes over 10% are bold and raise a warning; the job never fails the run, because hosted runners vary too much for a gate. Measure a warning again, on the same runner or on the Mac mini, before calling it a regression. Hosted runners decode video in software without a GPU, so idle CPU with the preview reads high there; compare builds, not absolute numbers. Windows has no `ps`, so it isn't measured.

## Guide budgets

`node --expose-gc apps/desktop/scripts/measure-guide.ts` generates a guide the size of a large panel's (1,300 guide channels, 70 programmes each, 36 MB) for a 13,000-channel catalogue, streams it through the guide service and reports download and indexing time, the longest main-process stall, reading from disk after a restart, now and next for 60 channels, search, and memory. `--file guide.xml` measures a real XMLTV file instead; keep provider files in `.local/`.

## Viewing record

`node apps/desktop/scripts/measure-viewing.ts [--events 100000]` fills a temporary database with that many events, mostly watches across 13,000 channels and some favourite changes, then reports how long a watch and a favourite take to commit, how long a start takes to open the database, and how long a start takes that rebuilds the lists from every event.

## CI

`.github/workflows/ci.yml` runs on every pull request and push to `main`, in two jobs:

- **Check:** unused files, exports and dependencies (`pnpm knip`), lint (`pnpm lint`), format, typecheck and the production build.
- **Test:** the suite, with the system ffmpeg for the conversion tests.

The [release workflow](releasing.md) runs both jobs on the exact commit it releases, next to the packaged-app test on every installed package. CI needs no secrets, so pull requests from forks run it too.
