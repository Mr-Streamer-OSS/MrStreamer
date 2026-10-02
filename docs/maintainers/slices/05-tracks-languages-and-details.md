# Slice 5: tracks, languages, versions and details

Status: merged on 1 October 2026, #21 to #36, and shipped in nightly `0.0.3-nightly.20261001.46`, built from `6a128ac`. A second review on 2 October found seven more problems, fixed in #37 to #43, with a follow-up in #44. Nightly `0.0.3-nightly.20261002.50` carries #37; the next nightly carries the rest. [Known gaps](#known-gaps) lists what remains open, use on a real subscription on the Mac and Windows first.

Outcome: live channels and movies and series offer every sound track and every subtitle format they carry, picture subtitles, teletext and captions included. Titles take their usual name in the viewer's language, a film's version can be picked and is remembered, Movies and Series search their own titles, details load only when a title opens and show the cast, and Settings gathers the content languages and updates under General, beside a clearer Subscription.

## Start here

- What users see: [Live TV](../../user/live-tv.md), [Movies and series](../../user/movies-and-series.md), [What plays](../../user/playback.md) and the [README](../../../README.md).
- How it works: [architecture](../../contributing/architecture.md#playback) for tracks, live subtitles and captions, [subtitles the app draws](../../contributing/architecture.md#subtitles-the-app-draws), [titles and versions](../../contributing/architecture.md#titles-and-versions), [TMDB](../../contributing/architecture.md#tmdb) and the [data](../../contributing/architecture.md#data) kept on disk; the [playback evaluation](../../contributing/playback-evaluation.md#subtitles-beyond-text) for how subtitles are shown.
- Baseline: `main` at `31fe500`, slice 4.5 with the README banner.

## Decisions

A review of `main` at `31fe500` by three reviewers, playback, catalogue and releases, found six correctness problems and set the scope. Wout settled seven questions:

| Question          | Answer                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| Playback coverage | Live TV and movies and series, whenever the stream carries tracks                              |
| Languages         | Content first: separate languages for titles, sound and subtitles. The interface stays English |
| Titles            | The usual name in the chosen language; the original in details; both findable                  |
| Quality           | The version is chosen automatically; a version picked by hand is remembered for that title     |
| Details           | TMDB with the provider's as fallback, loaded only when a title opens, never ahead              |
| Catalogue         | TMDB's background metadata stays, for browsing and names                                       |
| Subtitle formats  | Every format a stream carries, picture subtitles included; none deferred for being hard        |

The screens were picked from options compared side by side outside the repository:

| Part         | Pick                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------- |
| Tracks       | Sound and CC beside the volume, on live channels and titles; C turns subtitles on and off     |
| Versions     | A split Play button: the arrow opens Automatic and every version; one line says what plays    |
| Search       | A field at the end of Movies' and Series' tabs, posters in place of the tab, ⌘K one key away  |
| Details      | The sheet over the page, richer: the cast with photos, the original title, the version picker |
| General      | Rows with the control on the right: the content languages, titles for adults, TMDB, updates   |
| Subscription | Account and Catalogue as two lists of rows, each list with its own refresh                    |
| README       | Download first, then a tour with three screenshots                                            |

Wout added one fix while the slice was under way: on the Mac, the top bar didn't move back out to the window's edge when the window went full screen.

Made while building:

- **Subtitles are drawn over the untouched picture.** Burning picture subtitles in cost 6.55 s of CPU for 6 s of 1080p and re-encoded every copied picture; drawing them costs 0.04 s. The app decodes DVB, PGS, teletext and CEA-608 itself in TypeScript (`@mrstreamer/core/subtitles`), so no native library joins the bundle; ffmpeg gains the DVD and DivX decoders, the DVB subtitle encoder, the `sup` muxer and `filter_units`, about 0.3 MB. The [evaluation](../../contributing/playback-evaluation.md#subtitles-beyond-text) has the details.
- **Live subtitles** come from mpegts.js, which passes teletext and DVB packets on with times on the player's clock. Captions travel inside the pictures, which mpegts.js doesn't pass on, so the proxy copies them into a private stream of their own, listed only once a picture carries them.
- **Live sound** opens the stream again with the chosen track first in the program table, or converted alone; a channel opened afresh plays the remembered language. Subtitles never reopen anything.
- **A channel starts with subtitles in the viewer's language only when none of its sound tracks speaks it.** On a channel that does, they are for the hard of hearing, as teletext page 888 on Dutch channels mostly is.
- **Changing tracks keeps a paused title paused**, at the same picture, and subtitles move up above the controls while they show; they don't show in the muted previews.
- **Version picks** are `titleVersions` in the preferences, by kind and TMDB id, so provider stream ids stay out of the title's identity; connecting another subscription forgets them. Automatic carries on in the version a movie stopped in or a series was watched in, else plays the best suited. The details sheet shows the version that plays, so a series lists its episodes.
- **Original language** sound plays the language TMDB says a title was made in (`originalLanguage` on titles); without it, the file's default.
- **Names:** TMDB's name in the viewer's language, else the original when it is in that language, else English, else the original, else the provider's without its marks. Search finds every one of them.
- **Details** ask the provider and TMDB together when a title opens, TMDB for at most 4 s; nothing loads on hover or selection any more, and Continue watching takes its titles from the lists, asking the provider nothing.
- **Settings** has three tabs: General, Subscription and About. Updates moved into General.

## Review

The six findings, fixed first:

- A refused login answered with HTTP 200 emptied the movie list, and a second refresh saved the empty list: the provider's answer is now checked for a refused login before its rows are read (#21).
- Series the provider marks for adults outside an adult category showed in ordinary lists and search (#21).
- Retry did nothing after a title's first open failed, and Play again after the end could show playing over a paused picture (#22).
- Details opened before removing a subscription could reopen against the next one: account changes now close them (#22).
- A failed read of the deployed update feed counted as a first publication, which could put the feed back to older versions: publishing now stops (#23).

Each later part had a pre-PR audit, and fixed what it found before filing: live subtitles in Home's and the guide's muted previews, hard-of-hearing subtitles turning on by themselves on domestic channels, the details sheet showing the previous title while another loaded, a version pick replacing the other picks when the preferences hadn't loaded, provider names with version marks shown as original titles, and title details asked for again after a list refresh.

A second review, of `main` at `6a128ac` on 2 October, with Linux checks and probes of the services and controllers, found seven problems the tests had missed, each fixed and tested on its own:

- A Continue watching resume still waiting for a series' details reopened the last account's series after the subscription was removed or replaced (#37).
- Turning CC off on a movie cleared the line on screen, but the next one showed again while the menu said Off (#38).
- Switching channels with Up and Down kept the last channel's sound track and subtitles (#39).
- A paused movie whose new track needed a second try, converting its sound or reconnecting, started playing (#40).
- A film opened from the 4K tab played its HD version (#41).
- Details opened before TMDB's names arrived kept the provider's name and no original language, so Original language sound had nothing to go on (#42).
- Settings hid Check now while an update was on offer, a regression from #33 (#43).

It also found, by reading the code, that the live Sound menu marked a channel's first track while the sound in the viewer's language played (#44), and that captions sent only as CEA-708 show nothing (see [known gaps](#known-gaps)). The renderer had no tests before #37; its controllers and hooks now have their own, under happy-dom ([testing](../../contributing/testing.md)).

## Progress

| Part                             | Pull request                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------- |
| Review findings                  | #21 catalogue and adult series, #22 playback and account changes, #23 update feed |
| Track discovery and live sound   | #24                                                                               |
| Picture subtitles and broadcasts | #25, with the bundled ffmpeg's new components                                     |
| Full-screen top bar on the Mac   | #26                                                                               |
| Canonical names                  | #27                                                                               |
| Details on open                  | #28                                                                               |
| Sound and CC                     | #29                                                                               |
| Versions                         | #30                                                                               |
| Search in Movies and Series      | #31                                                                               |
| Richer details                   | #32                                                                               |
| Settings > General               | #33                                                                               |
| Settings > Subscription          | #34                                                                               |
| README and docs                  | #35                                                                               |
| A nightly checked on every push  | #36                                                                               |
| Second review                    | #37 to #43, and #44 for the live Sound menu                                       |
| This record                      | #45                                                                               |

## Evidence

Every pull request passed `pnpm knip`, `pnpm lint`, `pnpm fmt:check`, `pnpm typecheck` and `pnpm test` locally and in CI: 258 tests across 24 files after the second review, from 207 at the baseline. The packaged-app test passes on a development build, choosing the PGS and DVD subtitles under CC. #25's release dry run built and ran the packaged app with the bundled ffmpeg on macOS, Windows and Linux, picture subtitles included.

Driven in Electron on Linux against the fake provider, and the fake TMDB where names, cast or original languages mattered:

- A live channel looped from the subtitle clip: teletext page 888, captions and DVB pictures show under CC, C turns them off, Sound switches to Dutch with one new stream, and Escape closes a menu without leaving Watch.
- A paused title stays paused at the same position when its subtitles change and when C turns them off and on.
- A film in two versions shows once; each version plays its own clip, the pick survives reopening and Automatic clears it.
- Search on Movies with 800 titles shows "The best 300 of 595 movies"; Series finds no movie.
- Settings > General's Audio in Español and Original language start the two-track film in Spanish and in English, the language TMDB gives it.
- Settings > Subscription shows the account asked again, the counts of each list, and refreshes the guide alone.

On the workbench Mac mini, macOS 26.5.1, a development build with Homebrew's ffmpeg 9.0.2 gave the same results for every check above, and the packaged-app test passed all five steps. Its window keeps 92 px for the traffic lights; in native full screen the top bar starts 16 px from the edge, and returns to 92 px after (#26). A script can't press the green button there without accessibility rights, so full screen came through the HTML API, which takes the window native full screen and sends the same event.

On Linux, `pnpm dist:linux` at `e54666b` built the deb and the AppImage with the bundled ffmpeg and ffprobe, and the packaged-app test passed all five steps on the AppImage.

The release workflow for nightlies .46 and .50 built every installer, signed and notarized the Mac app and checked its signature, and ran the packaged-app test on the installed DMG, setup, deb and AppImage on hosted macOS, Windows and Linux runners. That is a smoke test against the fake provider, not use.

The README's screenshots come from the same kind of run as the checks, with made-up titles, people and artwork ([development](../../contributing/development.md#artwork)).

## Known gaps

- **Use on the Mac and Windows:** everything above ran against the fake provider. Windows ran only the release workflow's packaged-app test on a hosted runner, and the Mac checks ran on a development build. No use of the signed Mac app or the Windows nightly on a real subscription is recorded yet: live subtitles and Sound on a real channel, picture subtitles from a real Blu-ray rip, track changes while paused, versions, Settings, and an upgrade from the nightly before. The green button wasn't pressed by hand.
- **CEA-708 captions** are left out: the decoder reads CEA-608, which most broadcasts with captions also carry. A channel or file that sends captions only as CEA-708 shows none. Supporting them needs a real fixture first.
- The subtitle fixtures are generated: no real broadcast with teletext or captions, and no real Blu-ray PGS, has been played.
- After a skip, picture subtitles, teletext and captions already on screen show again only from their next change; live subtitles turned on show from the next line.
- Another live sound track starts the channel again, a moment's break.
- Text subtitles look dimmer while the controls, and the gradient behind them, show.
- Picking Captions, which have no language, clears the remembered subtitle language.
- Resuming a picked version from Continue watching was not driven end to end: the test clips are shorter than the two minutes a title needs to count as started.
- Continue watching can't tell a series is finished until Next episode finds nothing after the last episode.
- Connections in use and expiry come from the provider when Subscription opens; a real provider's numbers haven't been checked.
- Windows signing stays deferred.
