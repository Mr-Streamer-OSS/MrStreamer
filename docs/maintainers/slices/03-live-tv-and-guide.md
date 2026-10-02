# Slice 03: live TV discovery and programme guide

Status: built on 30 September 2026, waiting for Wout's Mac and Windows checks. The update-check race and Stable release notes shipped in #5 (`b3c4d8b`); discovery, the guide, Home and desktop navigation are in the slice 03 pull request. [Known gaps](#known-gaps) lists what remains open.

Outcome: quickly find something to watch now, navigate comfortably with a mouse or trackpad, and watch reliably on Mac, Windows and Linux.

## Start here

- The [decisions](#decisions) below record the approved design. [Architecture](../../contributing/architecture.md#programme-guide) describes the guide service, the one picture element and input handling; the [Live TV guide](../../user/live-tv.md) describes what users see.
- Baseline: Stable `0.0.1` and nightly `0.0.1-nightly.20260929.15`, both from `263950b`. Stable `0.0.1` is published; its source matches the promoted nightly. Returning to Stable keeps the data, including when the Stable version is older.
- Wout reported successful slice 02 testing on Mac and Windows on 30 September. That is user-reported acceptance, not independently repeated device evidence.

## Progress

Recorded 30 Sep 2026.

| Task                         | State                                                                                                                                                                                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 03.1 Update-check race       | Done in #5. Reproduced on current `main` first. Only the latest check counts; download and restart refuse a version the chosen channel doesn't receive. Three service tests fail on the old code and pass. Ships with the next nightly, `0.0.2-nightly.*`.                                                         |
| 03.2 Desktop navigation      | Done. Research and three layouts reviewed; Wout picked the guide page (B) with A's channel list in Watch, and grid Home (2). Built as below.                                                                                                                                                                       |
| 03.3 Discovery and the guide | Done. Provider XMLTV guide with now, next and the rest of the day; favourites; programme search. Measured against the budgets below.                                                                                                                                                                               |
| 03.4 Home                    | Done. Muted live backdrop of the last channel, programme first, one stream shared with Watch, checked in the packaged-app test.                                                                                                                                                                                    |
| 03.5 Verify and hand off     | Checks, tests, Linux packages and docs done. Mac and Windows builds come from a release dry run on the pull request; Wout's results are pending.                                                                                                                                                                   |
| After merging                | Nightly `.22` shipped #6. Wout's first run showed every Vlaanderen channel with Play Crime's programmes, and picture and sound playing fast at the start of each stream. Both fixed in the follow-up pull request: guide ids that name another channel are ignored, and catch-up jumps instead of playing at 1.2×. |
| 03.6 Stable release notes    | Done in #5. Notes list every pull request from the previous release of the channel to the commit the run builds; the first release of a channel lists everything. The published 0.0.1 notes were corrected to list #1 to #4; its files are unchanged.                                                              |

## Decisions

Settled with Wout on 30 September, in three rounds, from layouts compared side by side.

- **Guide data:** the provider's XMLTV, one download cached on disk, refreshed after connecting, at startup and when it is over six hours old. No per-channel requests: they covered no channel the XMLTV lacked. Browsing and playback never wait for it.
- **Guide depth:** now and next on every row, and the rest of today under a row (option L1). No time grid: most channels have no programmes, and a grid adds a second scroll direction.
- **Choosing:** a programme on now plays its channel; a later one shows its time and description. No reminders or recording.
- **Live TV:** a guide page (B). Lists on the left: favourites, recently watched, all channels, then countries and categories. Channel rows with now, progress, time left and next. The current stream plays muted on top. Watch opens over the page; Back returns to the same row.
- **Watch:** the full picture, programme first. A's channel list slides over the left for switching without leaving; its title swaps in the lists.
- **Home:** grids (2), two rows per section at most, vertical scrolling only. Favourites, recently watched, then your category, each with All. Watch and All channels on the backdrop; the category cards row is gone.
- **Sound:** only Watch plays sound by default. Leaving it keeps the stream muted; the speaker unmutes on Home and the guide.
- **Home preview:** the last channel plays muted. Without one, a favourite on now or the first channel in your category stands still. A refused preview stays still, without an error or retries. A hidden or minimised window stops the muted preview and restarts it when shown. No setting to turn it off for now.
- **Favourites:** S, the star on rows and in Watch. Kept in the order added; cleared with the history when the account changes.
- **Search:** channels, then programmes on now and later today.
- **Input:** hover only highlights; the keyboard selection is separate and the only thing that scrolls a list. Swipes and the wheel only scroll: the picture's swipe gestures are gone. A click on the picture shows the controls at once; a double click toggles full screen. Guide keys: arrows, Page Up/Down, Home/End, Enter watches, Right opens the day and Left closes it, Left again moves to the lists, digits, S, Escape goes Home.
- **Budgets:** download and indexing under 3 s; no main-process stall over 50 ms; now and next for a screen of channels under 5 ms; lists virtualised at 13,000 channels; under 80 MB for the guide; Home to Watch opens no extra connection. Windows and Linux GPU playback measurements are follow-up evidence and don't gate acceptance; Wout's Mac and Windows run is the acceptance.
- **Delivery:** #5 first, merged without waiting for Wout by agreement; the slice in its own pull request, with a release dry run for Wout's builds. It merges after his checks.

## Evidence

Provider facts, measured on 30 September on Wout's subscription with read-only requests:

- 12,970 channels in 267 categories. 4,329 carry a guide id; 2,074 have programmes in the XMLTV (Belgium 51%, the Netherlands 40%, the UK, France and the US none).
- The XMLTV is 32 MB and downloads in about 5 s. It covers 24 hours back and 24 ahead, about 88,000 programmes with titles and descriptions and no programme images. 39 entries end before they start and are skipped.
- The subscription allows one connection.

Guide budgets, `scripts/measure-guide.ts` on the workbench VPS (12 cores, other work running), three runs each:

| Measure                        | Generated, 36 MB, 1,300 guide channels | Wout's XMLTV, 32 MB | Budget |
| ------------------------------ | -------------------------------------- | ------------------- | ------ |
| Download and index             | 1.4 to 1.7 s                           | 1.8 to 2.2 s        | 3 s    |
| Longest main-process stall     | 14 to 52 ms                            | 15 to 39 ms         | 50 ms  |
| Read from disk after a restart | 1.3 s                                  | 1.3 to 1.7 s        |        |
| Longest stall while reading    | 13 to 16 ms                            | 14 to 31 ms         | 50 ms  |
| Now and next for 60 channels   | 0.03 ms or less                        | 0.02 ms or less     | 5 ms   |
| Programme search               | 10 to 19 ms                            | 8 to 10 ms          |        |
| Memory held by the guide       | 23 MB                                  | 22 MB               | 80 MB  |

One generated download stalled for 52 ms; earlier runs on the busy VPS reached about 65 ms, from garbage collection during the download. Reading the bytes and decoding one programme at a time cut memory from 62 MB to 22 MB, which also shortened collection pauses.

Checks on the slice 03 branch:

- 112 tests in 9 files, unused-code checks, lint, formatting and types pass.
- The packaged-app test passes on a development build, and on a locally built AppImage and deb (`0.0.2-nightly.20260930.0`, headless under Xvfb, with the system ffmpeg because the VPS lacks nasm to build the bundled one). Both channels play, and Home and Watch share one stream: muted on Home, with sound in Watch, no second provider request.
- Driving the development build against the fake provider: guide to Watch to guide to Home to Watch made one stream request. Hiding the window released the connection and showing it restarted the preview. With another client holding the only connection, the preview gave up after the proxy's two quick retries, showed no error, and made no new request when the window was hidden and shown again. A stream that stalled after leaving Watch made no reconnect attempts. Edit login released the connection. Keyboard selection, the rest of the day, S and Watch's lists behaved as specified.
- An independent review found no blockers. Its findings on the preview policy (refused previews retrying on show, reconnects after leaving Watch, playback continuing behind the login form), digits carrying over between views and keys acting behind the update dialog were fixed and rechecked.
- Stable 0.0.1's own code reads a catalogue and preferences written by this branch, offline, and keeps the favourites when it saves.

## Known gaps

- Wout's Mac and Windows checks of the dry-run builds: navigation with a trackpad and a mouse, Home preview and sound, the guide with his provider, favourites, search, and the updater once a nightly carries #5.
- Playback measurements on Windows and on a Linux desktop with a GPU; the headless checks above are not GPU evidence.
- Guide stalls near the 50 ms budget on the busy VPS; measure on Wout's Mac. If they exceed it there, move indexing to a worker thread.
- Programme artwork: the provider sends none, so rows use the channel's logo or initials.
- The ultrawide layout that kept the guide beside the picture is gone; on a wide window the channel list covers the black bar beside the picture instead.
- Favourites can follow a round trip through Stable 0.0.1 into another account: 0.0.1 keeps unknown preference fields when it switches accounts. Back on a newer build, the old ids may match other channels. Storing the account with the favourites would close it; it needs a nightly, a return to Stable and an account switch.

## Scope boundaries

Not in this slice: time grid, reminders, recording, catch-up, multiview, programme artwork or external metadata, manual favourite ordering, a setting to turn off Home autoplay, movie and series browsing, multiple subscriptions, mobile and TV apps and Windows signing. The release policy is unchanged: automatic nightlies, Stable by promoting a nightly's commit.

## References

- [Stable 0.0.1](https://github.com/Mr-Streamer-OSS/MrStreamer/releases/tag/v0.0.1)
- [#5: late update checks and Stable notes](https://github.com/Mr-Streamer-OSS/MrStreamer/pull/5)
