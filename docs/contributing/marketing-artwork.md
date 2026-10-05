# Marketing artwork

The website shows four captures of the real app. They live in `docs/assets`:

| File                     | Shows                                                                           |
| ------------------------ | ------------------------------------------------------------------------------- |
| `marketing-home.png`     | Home, with a channel playing, a series to continue and two favourites           |
| `marketing-live-tv.png`  | Live TV, with eight channels and what's on now and next                         |
| `marketing-library.png`  | A series' details, with its story, cast, seasons and Play                       |
| `marketing-watching.png` | An episode playing, its subtitle on screen and the subtitle menu open over them |

Each is the whole window at 1280 × 800 points and twice the pixels, 2560 × 1600, saved as a lossless PNG. `apps/marketing/scripts/prepare-assets.ts` cuts every size the page uses from these four files, and the social picture too. The page changes when you commit new captures and at no other time.

Nothing in them comes from a real provider, film or person. The channels, programmes, titles, cast and subtitles are invented, and [`docs/assets/marketing-demo-sources.json`](../assets/marketing-demo-sources.json) lists every one. The moving pictures are public domain. Keep it that way. No provider's catalogue, no real posters, no real faces, no agency emblems.

## What you need

- Linux with `xvfb-run` (`apt install xvfb`).
- `ffmpeg` and `ffprobe` on PATH. `MR_STREAMER_FFMPEG` points both the app and these scripts at another ffmpeg, with its ffprobe beside it.
- [Inter](https://rsms.me/inter/) installed. Linux draws the app in the system's sans-serif font, and the capture script makes that Inter for its own run. It stops if Inter is missing.
- 2.2 GB free in a folder outside the repository for the downloads and the clips cut from them.

## Run it

```sh
pnpm install
pnpm build
node apps/desktop/scripts/marketing-demo.ts --cache-dir ~/.cache/mrstreamer-marketing
xvfb-run -a node apps/desktop/scripts/marketing-capture.ts --cache-dir ~/.cache/mrstreamer-marketing
pnpm build:marketing
```

The first script downloads and cuts the footage, about a minute and a half after the downloads. The second takes half a minute and writes the four files. `pnpm build:marketing` then builds the page from them.

The cache folder stays out of git. Pick one outside the repository, or under the gitignored `.local/`.

## Sources

| Footage             | Source                                                                                                                                                                                                                                                                    | Part used      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Earth, on a channel | [4K Earth Views Extended Cut for Earth Day 2021](https://images.nasa.gov/details/jsc2021m000138_4K_Earth_Views_Extended_Cut_for_Earth_Day_%202021_210422-4KMP4), NASA Johnson Space Center. The 1080p download, 2,040,459,091 bytes.                                      | 09:00 to 11:00 |
| Canyon, in a series | [Grand Canyon South Rim summer time-lapse](https://www.nps.gov/grca/learn/photosmultimedia/b-roll_hd01.htm), U.S. National Park Service. The [1080p file](https://www.nps.gov/nps-audiovideo/audiovideo/49968ade-360e-4946-bfee-facd5086245d1080p.mp4), 33,836,539 bytes. | 00:10 to 00:40 |

The manifest holds each file's address, SHA-256 and the day it was fetched, 4 October 2026. `marketing-demo.ts` checks the SHA-256 before it uses a download.

Credit them as "NASA" and "U.S. National Park Service" wherever the pictures appear. Both are free to use: [NASA's media guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/) and the [park's B-roll archive](https://www.nps.gov/grca/learn/photosmultimedia/b-roll_hd_index.htm) say so. Neither agency endorses Mr. Streamer, and the captures show neither's emblem. The original sound of both clips is left out.

## What the scripts do

`marketing-demo.ts` cuts three things from the downloads:

- `earth-loop.ts`, two minutes of Earth as H.264 with silent AAC sound, in an MPEG-TS file. Every channel plays it.
- `canyon-hours.mkv`, thirty seconds of the canyon as H.264, with two generated AAC sound tracks marked English and Dutch and two SubRip subtitle tracks in the same languages. ffprobe has to find exactly those tracks.
- Stills of the same canyon clip for the series' poster, backdrop and episodes.

It also starts the made-up subscription, on loopback ports of its own:

- The fake provider from the tests, unchanged, streaming the Earth loop through its `streams` option.
- An adapter in front of it. The app logs in to the adapter. It lists the manifest's eight channels and seven series under the fake provider's ids, answers the guide, and serves the episode's file by byte range.
- The fake TMDB behind a wrapper that answers with the manifest's names, stories and credits. The app reaches it through `MR_STREAMER_TMDB_API` with a made-up key.

`marketing-capture.ts` starts the development build with a throwaway profile and update checks off, then drives it through its DevTools port as a viewer would:

1. Logs in through the form.
2. Opens Canyon Hours and captures its details.
3. Plays the first episode, turns on English subtitles, raises them with Subtitle look > Position > Higher so the menu doesn't cover them, opens the subtitle menu and captures.
4. Leaves the episode, which puts the series under Continue watching.
5. Stars two channels in Live TV, watches one and captures Live TV.
6. Watches another channel, goes Home and captures.

Each capture is the page of the window, taken with `Emulation.setDeviceMetricsOverride` at 1280 × 800 and a scale of 2, then `Page.captureScreenshot`. `Emulation.setScrollbarsHidden` keeps scroll bars out of it, as on a Mac, where they show only while scrolling. A page capture doesn't include the window's buttons. Home, Live TV and the details are captured in full screen, where the top bar keeps no room for those buttons. The episode is captured in a window, because in full screen the player hides the top bar.

The app's pictures never come from the network. The script answers the image addresses the demo hands out from the page's DevTools session, with the canyon stills and drawn artwork, and refuses any other remote image.

A capture is written only once it holds what it should: the right size, the names and tracks on screen, a decoded picture where the video is, and for the episode the subtitle "By evening, the colours change again." still showing after the capture was taken. The clock times in the captures are the moment you ran it.

The script ends the app and the servers it started and deletes its profile. It touches no other process.

## Before you commit new captures

- Look at all four files at full size. Check the names, the pictures and the subtitle against the manifest.
- Run `pnpm build:marketing` and look at the page on a wide screen and a phone. The phone shows a part of each window, set in `prepare-assets.ts`. If the app's layout moved, move those parts with it and keep `index.html`'s sizes in step.
- Put the four files' sizes in the pull request, each and in total. They are lossless and run to a few megabytes.

The current captures show version 0.0.6 at commit `1072c0a`, as a development build on Electron 44.4.5, taken on Ubuntu 24.04 with ffmpeg 6.1.1 on 4 October 2026.
