# Testing

The suite checks what the services promise, through their public functions, against a fake provider. It stays small: each test describes a behaviour a user or the release process depends on.

| File                                     | Covers                                                                                                                                                                                                                                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/test/subscription.test.ts` | Logins, M3U links, account states, restarts, removal racing a slow account check, keychain loss                                                                                                                                                                                                       |
| `apps/desktop/test/library.test.ts`      | Loading, search, cache after restart, caches saved before guide ids, failed, empty and short refreshes, ids across renames                                                                                                                                                                            |
| `packages/core/test/catalogue.test.ts`   | Display names and region grouping                                                                                                                                                                                                                                                                     |
| `apps/desktop/test/ondemand.test.ts`     | Movie and series lists: first use, newest first, adult titles only in their own category, search, seasons built from episodes, restarts, failed refreshes, account changes                                                                                                                            |
| `packages/core/test/ondemand.test.ts`    | Title and episode names, long lists read row by row, when a title counts as finished, one Continue watching entry per series                                                                                                                                                                          |
| `apps/desktop/test/preferences.test.ts`  | Partial updates, forgetting on account changes, restarts, keys of newer versions, files that still carry favourites and history                                                                                                                                                                       |
| `apps/desktop/test/diagnostics.test.ts`  | What the log records for a session, without addresses, logins or channel names; rotation                                                                                                                                                                                                              |
| `apps/desktop/test/viewing.test.ts`      | Favourites and history order across restarts, commands sent again, accounts, change notices, the one-time import from `preferences.json`, rebuilding from events, records from before movies and series, how far movies and episodes got, removing from Continue watching, a database that can't open |
| `apps/desktop/test/guide.test.ts`        | Now and next, the rest of the day, untidy XMLTV in small pieces, guide ids shared by unrelated channels, programme search, restarts from disk, six-hour refreshes and failed ones, answering before the first download, account changes                                                               |
| `apps/desktop/test/playback.test.ts`     | The local proxy, one-connection switching, quitting, refusals, and what the player receives for each codec clip                                                                                                                                                                                       |
| `apps/desktop/test/titles.test.ts`       | Movies and episodes: track names, playing from a position with cues on the file's clock, copied and converted sound and picture, the chosen track, MP4 read by byte ranges, missing files, one connection while seeking                                                                               |
| `apps/desktop/test/updates.test.ts`      | Channels, release routing, going back to Stable, closed notices, downloads and retries, channel switches, checks answering late, the four-hourly schedule and its backoff, the feed, GitHub as the fallback and its limits                                                                            |
| `apps/desktop/test/installer.test.ts`    | The electron-updater adapter: cancelling at every step, one download at a time, refused installs                                                                                                                                                                                                      |
| `apps/desktop/test/licences.test.ts`     | Third-party notices: which packages the bundles hold, NOTICE files, what fails the build, prebuilt files, components, reading notices and Chromium's credits                                                                                                                                          |
| `test/release.test.ts`                   | Version order, when a nightly is due, which commit a stable release builds, release notes, refused versions, and the update feed                                                                                                                                                                      |

`pnpm test` runs them all. The conversion and title tests need `ffmpeg` and `ffprobe`: they use the ones on PATH, or `MR_STREAMER_FFMPEG` and the ffprobe beside it, and skip without them. CI installs both.

## Fake provider and codec clips

`apps/desktop/test/fake-provider.ts` answers like an Xtream Codes panel, with the untidiness of real ones: prefixed names, separator entries, numbers sent as strings, missing logos, one connection at a time. Tests can make catalogue requests fail or change the channels it lists. About half its channels have a guide id, shared by variants of one channel, and `xmltv.php` serves half-hour programmes around the current time. Tests can replace that document, fail it, hold it open or send it in pieces of a few bytes, and count guide and stream requests. Its "TEST | Formats and failures" category streams the clips in `test/fixtures`, plus an offline channel.

It lists 120 movies and series by default, in their own categories, one of them for adults. Their files redirect to another address and answer byte ranges, and each open file holds a connection slot. The "TEST" movies and the "TEST | Formats" series play the title clips, and one test movie has no file; the rest play the MP4 clip. Tests can fail the lists and count file requests.

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

Three title clips stand in for movies and episodes, with the same test picture and tone:

| Clip                       | What it holds                                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title-h264-eac3-subs.mkv` | 20 s, a keyframe every 5 s; E-AC-3 5.1 in English and a Spanish AAC commentary at 660 Hz; English SubRip subtitles at 2, 12 and 17 s, and forced Spanish ones at 12 s |
| `title-h264-aac.mp4`       | 12 s, AAC marked Dutch, English `mov_text` subtitles, and the index at the end, as ffmpeg writes MP4 by default                                                       |
| `title-mpeg4-mp3.avi`      | 6 s of MPEG-4 Part 2 with MP3: a picture the player doesn't decode                                                                                                    |

```sh
# en.srt: "First line" 2-4 s, "Twelve seconds" 12-14 s, "Seventeen" 17-19 s; es.srt: "Doce" 12-14 s
ffmpeg -f lavfi -i testsrc2=size=128x72:rate=25 -f lavfi -i sine=frequency=440:sample_rate=48000 \
  -f lavfi -i sine=frequency=660:sample_rate=48000 -i en.srt -i es.srt -t 20 \
  -map 0:v -map 1:a -map 2:a -map 3 -map 4 -c:v libx264 -preset medium -crf 32 -pix_fmt yuv420p \
  -g 125 -keyint_min 125 -sc_threshold 0 -c:a:0 eac3 -ac:a:0 6 -b:a:0 96k -c:a:1 aac -ac:a:1 2 -b:a:1 32k \
  -c:s srt -metadata:s:a:0 language=eng -metadata:s:a:1 language=spa -metadata:s:a:1 title=Commentary \
  -disposition:a:0 default -disposition:a:1 0 -metadata:s:s:0 language=eng -metadata:s:s:1 language=spa \
  -disposition:s:0 0 -disposition:s:1 forced title-h264-eac3-subs.mkv
ffmpeg -f lavfi -i testsrc2=size=128x72:rate=25 -f lavfi -i sine=frequency=440:sample_rate=48000 -i en.srt -t 12 \
  -map 0:v -map 1:a -map 2 -c:v libx264 -preset medium -crf 32 -pix_fmt yuv420p -g 50 -c:a aac -ac 2 -b:a 32k \
  -c:s mov_text -metadata:s:a:0 language=nld -metadata:s:s:0 language=eng title-h264-aac.mp4
ffmpeg -f lavfi -i testsrc2=size=128x72:rate=25 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 6 \
  -c:v mpeg4 -q:v 8 -g 50 -c:a libmp3lame -b:a 32k -ac 2 title-mpeg4-mp3.avi
```

## Packaged app

`apps/desktop/test/e2e/packaged-app.ts` starts a built app with a throwaway profile, connects it to the fake provider through the login form, and plays a channel that passes straight through and one the bundled ffmpeg converts. Then it leaves Watch for Home and watches again from there. Last, it opens a movie from Movies, which the bundled ffprobe reads and ffmpeg repackages, skips 10 seconds ahead and leaves. It passes when both channels show a moving picture with decoded sound, Home plays the same stream muted while Watch plays it with sound, without another request to the provider, and the movie plays with sound, skips and holds no connection once left.

```sh
node apps/desktop/test/e2e/packaged-app.ts "/Applications/Mr. Streamer.app/Contents/MacOS/Mr. Streamer" -- --use-mock-keychain
node apps/desktop/test/e2e/packaged-app.ts "$LOCALAPPDATA\Programs\mrstreamer\Mr. Streamer.exe"
xvfb-run -a node apps/desktop/test/e2e/packaged-app.ts "/opt/Mr. Streamer/mrstreamer" -- --no-sandbox
```

`--use-mock-keychain` keeps a macOS run away from the real Keychain. Without FUSE, run an AppImage with `APPIMAGE_EXTRACT_AND_RUN=1` in the environment. A development build runs it too, after `pnpm build`: `xvfb-run -a node apps/desktop/test/e2e/packaged-app.ts node_modules/electron/dist/electron -- --no-sandbox "$PWD"`.

## App measurements

`node apps/desktop/test/e2e/measure-app.ts [--json results.json] <app executable> [-- app arguments]` drives a built app against the fake provider at the size of a large subscription: 13,000 channels, about 2,000 with a guide, and a continuous 720p stream that ffmpeg encodes as it plays. It prints medians for cold start, time to picture, channel switch, opening the guide, search, idle CPU and memory on Home with and without the muted preview, and the installed size. Slice handoffs record its numbers for comparison. It shares its DevTools client and login with the packaged-app test (`apps/desktop/test/e2e/app.ts`). `--json` also writes every run of every measure.

`node apps/desktop/test/e2e/compare-builds.ts [--rounds 3] <baseline> <candidate> [-- app arguments]` measures two builds on one machine, alternating which goes first each round, and prints each measure's median before and after with the change. A machine that drifts during the runs affects both builds alike, which is what makes shared machines usable. The release workflow runs it for every nightly and dry run on macOS and Linux, against the last nightly, and puts the table in the run summary. Changes over 10% raise a warning when they are also beyond noise: more than 20 ms, a point of CPU or 10 MB. The job never fails the run, because hosted runners vary too much for a gate. Measure a warning again, on the same runner or on the Mac mini, before calling it a regression. Hosted runners are virtual machines that may decode video in software, so compare builds there, not absolute numbers. Windows has no `ps`, so it isn't measured.

## Guide budgets

`node --expose-gc apps/desktop/scripts/measure-guide.ts` generates a guide the size of a large panel's (1,300 guide channels, 70 programmes each, 36 MB) for a 13,000-channel catalogue, streams it through the guide service and reports download and indexing time, the longest main-process stall, reading from disk after a restart, now and next for 60 channels, search, and memory. `--file guide.xml` measures a real XMLTV file instead; keep provider files in `.local/`.

## Viewing record

`node apps/desktop/scripts/measure-viewing.ts [--events 100000]` fills a temporary database with that many events, mostly watches across 13,000 channels and some favourite changes, then reports how long a watch and a favourite take to commit, how long a start takes to open the database, and how long a start takes that rebuilds the lists from every event.

## CI

`.github/workflows/ci.yml` runs on every pull request and push to `main`, in two jobs:

- **Check:** unused files, exports and dependencies (`pnpm knip`), lint (`pnpm lint`), format, typecheck and the production build.
- **Test:** the suite, with the system ffmpeg for the conversion tests.

The [release workflow](releasing.md) runs both jobs on the exact commit it releases, next to the packaged-app test on every installed package. CI needs no secrets, so pull requests from forks run it too.
