# Slice 04: movies, series, Home, updates and licences

Status: built on 30 September 2026 on `t3code/movies-home-updates-licences`, in review. Nothing is merged or published, and the update feed isn't deployed. [Known gaps](#known-gaps) lists what remains open.

Outcome: movies and series from the subscription, with resume, seasons, tracks and subtitles; a Home built around what you're watching; updates found without GitHub's API limit; and notices for everything the installers ship.

## Start here

- What users see: [Movies and series](../../user/movies-and-series.md), [Home](../../user/live-tv.md#home), [Updates](../../user/updates.md) and [What plays](../../user/playback.md).
- How it works: [architecture](../architecture.md#movies-and-series) for the on-demand catalogue, [movies and episodes](../architecture.md#movies-and-episodes) for playback, [viewing record](../architecture.md#viewing-record), [updates](../architecture.md#updates) and [licences](../architecture.md#licences). The [playback evaluation](../playback.md#movies-and-episodes) records the real provider's formats and why every title goes through ffmpeg. [Releasing](../releasing.md#update-feed) covers the feed.
- Baseline: `main` at `6f6bf5e`, slice 3.5 with the build comparison (#15). Stable 0.0.2 (`f26072f`) is the published build before this slice.

## Decisions

Scope came from Wout's slice 04 brief. The layouts were picked from three options per screen, compared side by side outside the repository, on 30 September:

| Screen              | Picked                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------- |
| Home                | B: one row per section, vertical scrolling only, each row's All opens the full list           |
| Movies and Series   | A: lists on the left, a poster grid on the right. No pick was given; A was the recommendation |
| Details             | B: a sheet over the page, which stays in place behind it                                      |
| Update notice       | A: in the top bar                                                                             |
| Updates in Settings | A: status first, with a visible Back                                                          |
| About and licences  | A: a list, and the full text beside it                                                        |

The reply was "B - B and A A A". Read in order over the six screens with a choice, the dash is Movies and Series. If Wout meant otherwise, each screen is its own component and switches alone.

Questions answered with the recommendation:

- **Adult titles** stay out of Home, Recently added and search, and show only in their own category. No setting.
- **Finishing** an episode keeps the series in Continue watching as "Next: S1 E4" until there is no next one; a finished movie leaves. Started after 2 minutes, finished in the last 5 % (at least 30 s).
- **Tracks:** the languages picked last are chosen in the next title that has them. Without a choice, the file's default sound and only forced subtitles in its language.

Open: **where the feed lives.** The app reads `https://mr-streamer-oss.github.io/MrStreamer/updates.json`, GitHub Pages without a domain. The alternative is a domain Wout controls pointed at Pages, such as `updates.mrstreamer.app`, so the host can move later; the address ships in every build, so pick before the first release that has it.

Made while building:

- **One path for every title:** ffmpeg repackages from the chosen position, for Media Source Extensions. Chromium plays MKV and MP4 faster on its own, but lists no sound tracks, shows no embedded subtitles and plays no E-AC-3 on Linux; the [evaluation](../playback.md#movies-and-episodes) has the numbers.
- **One provider connection:** opening a title closes the live stream, Movies and Series stop the muted preview, and Home restarts it. The title's proxy keeps one upstream request open at a time and retries a refusal, since panels free a closed connection late.
- **Progress** is an event in the viewing record per account, written every minute and on pause, skip, track change, finish and leaving, never per frame. Continue watching takes the positions from the record and each title's artwork and episodes from its details, which the main process caches while it runs.
- **The catalogue** loads in a worker thread: the real subscription's 53,000 movies and 10,000 series took 8 s to download and up to 2 s to index, which stalled the main process for 50 to 326 ms on the main thread.
- **Updates** come from a static `updates.json` for both channels, published by the release workflow after each complete release. GitHub's API is asked only when the feed is missing or broken, never while offline or while GitHub limits requests. The 403s reported before were most likely that limit: 60 requests an hour per address without a token, shared by everyone behind the same address. Checks run 20 s after starting and every 4 hours, back off from 15 minutes to 4 hours after failures, and never download on their own.
- **Notices** come from what the bundles hold, devDependencies included, plus Electron, Chromium, Node.js, FFmpeg and x264. The build fails on a package without a licence file or with a licence not on the compatible list.

## Review

Findings from reviewing the foundation, each reproduced or read in the code before fixing:

- A stable release could be promoted while a newer nightly published, and could promote a nightly that wasn't the tested one. Nightlies and Stable now share one release queue, and a Stable run can name the nightly Wout tested.
- An interrupted update download could overlap the next one: downloads now run one at a time. Writes of `updates.json` settings could interleave: they are serialized.
- Leaving Watch in the middle of a channel switch could leave a muted stream reconnecting. Channel digits being typed survived a view covering them. The stall watchdog counted a pause as a stall. All fixed.
- Nothing else was reopened: the slice 3.5 findings stay resolved.

## Progress

| Stage                         | State                                                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Release queue and update feed | Done (`f496672`). One release queue, the tested nightly as input, `updates.json` on GitHub Pages after each release. |
| Titles, progress and playback | Done (`16c9e69`). Provider on-demand API, catalogue worker, title sessions, title events in the viewing record.      |
| ffmpeg and ffprobe            | Done (`0f27e22`). The bundled build reads files over HTTP and carries ffprobe.                                       |
| Notices                       | Done (`244ea7c`). Generated at build time, shown in Settings > About.                                                |
| Update checks                 | Done (`1dfd19e`). The feed, the schedule, backoff, dismissals and a quiet notice.                                    |
| Screens                       | Done (`b60af20`). Home, Movies, Series, details, watching a title, Updates settings, About.                          |
| Docs and verification         | Done in the last commit. README and every guide rewritten; this handoff.                                             |

## Evidence

Checks at the final revision: `pnpm knip`, `pnpm lint`, `pnpm fmt:check`, `pnpm typecheck` and `pnpm test` pass.

Packaged app, Linux x64, `0.0.3-nightly.20260930.99` built on the workbench VPS: the packaged-app test passes on the extracted deb and on the AppImage under Xvfb, including the new movie step (picture and sound, a 10 s skip, no connection left once closed). The VPS has no GPU: this is functional evidence, drawn and decoded in software, not performance evidence for a Linux desktop.

On the real subscription, from the workbench: the catalogue downloaded in 8 s and indexed in 0.7 to 2 s in the worker; the first page of posters answered in 133 ms and a search in 16 ms. Seventeen real files probed through the proxy in 0.4 to 5.5 s.

Against the fake provider in Electron: a title starts in about 1.1 s and seeks outside the buffer in 0.9 s; starting 10 minutes into a 36-minute file read 57 MB, and nothing more while paused. Driving the development build: Continue watching showed a series as "Next: S1 E2" and a movie with its time left; the series sheet offered "Play S1 E2"; Next episode went from E2 to E3; Back returned to the sheet; leaving held no stream and no file open. About listed 55 notices.

## Known gaps

- Mac and Windows: installers come from the release dry run on the pull request. Wout's checks on both are pending: browsing and playing movies and episodes with his provider, tracks, resume, the update notice and About.
- GPU evidence: none on Linux or Windows. Pictures the player can't decode, such as HEVC where the system has no decoder or MPEG-4 Part 2, become H.264 in software; 4K HEVC on such a machine will cost a lot of CPU.
- The feed goes live only once Wout enables GitHub Pages (Settings > Pages > Source: GitHub Actions) and the first release after merging runs; until then the app asks GitHub's API, as before. The feed's address is still open, above.
- Picture subtitles (PGS, VobSub) are listed but can't be shown.
- A pause over five minutes lets go of the connection; playing again reopens the file at the same position, which takes about a second.
- Downloads, trailers, external metadata, other provider types, several subscriptions and mobile or TV apps are out of scope.
