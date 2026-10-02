# Playback evaluation

How the playback design was chosen, measured on real streams and files. The [architecture](architecture.md#playback) describes the design itself.

## Samples

Fourteen one-minute recordings of real channels from a subscription, made without the login leaving the machine that recorded them. They stay private: they contain broadcast content and are not part of the repository. Each covers a failure class found by probing the subscription, next to working baselines:

| #   | Format                          | Why                                                          |
| --- | ------------------------------- | ------------------------------------------------------------ |
| 01  | H.264 1080p50, AAC              | Baseline                                                     |
| 02  | H.264 1080i25 open GOP, MP2     | MP2 sound; interlaced fields; leading frames on joining      |
| 03  | H.264 1080i25, MP2 and AC-3 5.1 | Two sound tracks                                             |
| 04  | H.264 1080i25, AC-3 2.0         | AC-3                                                         |
| 05  | H.264 720p50, AC-3 5.1          | AC-3 surround                                                |
| 06  | H.264 720p50, MP2               | MP2                                                          |
| 07  | HEVC Main 10 1080p50, AAC       | 10-bit HEVC                                                  |
| 08  | HEVC 2160p50, AAC               | 4K HEVC                                                      |
| 09  | MPEG-2 720 × 484, no sound      | MPEG-2                                                       |
| 10  | H.264 2160p24, AAC              | 4K H.264                                                     |
| 11  | H.264 720p60, AAC               | Baseline                                                     |
| 12  | H.264 1080p24, AAC 5.1          | Surround AAC                                                 |
| 13  | MP3 radio in MPEG-TS            | Sound only                                                   |
| 14  | H.264 1080i25, MP2, damaged     | Lost packets and frames without timestamps from the provider |

In a random sample of 45 channels, 17 didn't answer (off air, or the single connection still busy), 23 of the 28 that did were H.264 with AAC, and the rest were MP2 sound, MPEG-2, HEVC 4K and plain MP3 radio. Channel names say little: most "UHD", "4K" and "HEVC" channels are H.264.

## Candidates

1. **Chromium alone**: mpegts.js into Chromium's decoders, the first player.
2. **Chromium plus a bundled ffmpeg**: the design now shipped. Streams Chromium decodes pass through untouched; ffmpeg converts only the tracks it can't, starts streams on a decodable picture, and repairs damaged broadcasts.
3. **mpv**: the standalone player, as the reference for what libmpv would decode and what it costs. Embedding libmpv in the window was not built: it needs native code per platform to place a video surface under a transparent window, has no Wayland support, and adds libraries to sign and ship.

Each sample played through the real app UI (search, Enter) from a local server replaying the recordings. The harness waits until the clock runs steadily, then measures 25 s: decoded sound, dropped frames, and the CPU and memory of every app process, including ffmpeg.

## Results

**Apple M4, macOS 26.5** (hardware decoding; CPU is the share of one core; memory is all app processes together):

| #   | Chromium alone                  | Chromium plus ffmpeg            | mpv         |
| --- | ------------------------------- | ------------------------------- | ----------- |
| 01  | 0.7 s, 18 %                     | 0.6 s, 18 %                     | 2.1 s, 33 % |
| 02  | Fails: video decode error       | 1.5 s, 30 %                     | 0.8 s, 42 % |
| 03  | Fails                           | 1.3 s, 35 %                     | 0.7 s, 42 % |
| 04  | Fails: AC-3 unsupported         | 1.4 s, 44 %                     | 0.7 s, 49 % |
| 05  | Fails: AC-3 unsupported         | 1.5 s, 24 %                     | 0.9 s, 25 % |
| 06  | Fails: MP2                      | 0.9 s, 21 %                     | 0.6 s, 25 % |
| 07  | 0.4 s, 22 %                     | 0.4 s, 21 %                     | 1.1 s, 34 % |
| 08  | 0.5 s, 12 %                     | 0.5 s, 12 %                     | 1.3 s, 22 % |
| 09  | No picture, reported as network | 1.5 s, 21 %                     | 1.1 s, 22 % |
| 10  | 0.4 s, 13 %                     | 0.5 s, 13 %                     | 1.2 s, 23 % |
| 11  | 0.8 s, 16 %                     | 0.8 s, 16 %                     | 0.7 s, 29 % |
| 12  | 0.5 s, 13 %                     | 0.5 s, 13 %                     | 1.2 s, 21 % |
| 13  | 1.1 s, 4 %                      | 1.1 s, 4 %                      | 0.5 s, 11 % |
| 14  | Fails                           | About 12 s, then 124 % (repair) | 0.7 s, 47 % |

No candidate dropped frames once playing. The app used 700 to 860 MB across its processes, mpv 270 to 570 MB. mpv's start includes launching the process, and it decoded the interlaced channels (02 to 04, 14) in software, like Chromium does.

**Linux, headless x64 server without a GPU** (software decoding and drawing): functional only. Chromium alone fails every MP2, AC-3, HEVC and MPEG-2 sample. With ffmpeg, all of them start with picture and sound, and the packaged app passes the MP2 conversion smoke test on this server and on GitHub's Ubuntu runner. Performance numbers from this machine don't transfer: 1080p50 took two cores and dropped 40 % of frames in both the app and mpv. A Linux desktop with a GPU remains to be measured.

**Windows:** the packaged-app smoke test passes on GitHub's Windows runner, including an MP2 conversion. Measurements on a real Windows PC remain to be done.

## Decision

Chromium plus a bundled ffmpeg. On the Mac it plays every sample, as mpv does, while keeping hardware decoding, the approved UI and its controls, and it costs no more CPU on the channels that play directly, which are most of them. Converted channels start about half a second later than in mpv, and damaged broadcasts cost a slow retry, where mpv shows them at once. The ffmpeg is a small separate process built from pinned sources for each platform (7 MB), so a crash can't take the app down and it signs and notarizes like the rest of the app.

libmpv was kept in reserve for movies and series, in case subtitles and seeking needed more than Chromium offers; [Movies and episodes](#movies-and-episodes) records how they turned out without it.

## Budgets

For Apple silicon Macs, from these measurements, per channel:

| Measure                                     | Budget           |
| ------------------------------------------- | ---------------- |
| Picture after choosing a channel, direct    | 1.0 s            |
| Picture after choosing a channel, converted | 2.0 s            |
| CPU, direct 1080p or 4K                     | 25 % of one core |
| CPU, converted sound, 1080i                 | 50 % of one core |
| Dropped frames while playing                | None             |
| Memory, all processes                       | 900 MB           |

Windows and Linux budgets follow their measurements on real hardware.

## Movies and episodes

The on-demand side of the same subscription, read before movies and series were built, held 53,422 movies and 10,440 series. Of the movies, 66 % are MKV, 33 % MP4, 1 % AVI, and a few dozen MPEG-TS, MPEG-PS, M4V and FLV. Every file sits behind a redirect to a CDN that answers byte ranges.

ffprobe through a local range proxy read 17 of 20 sampled files; the other three didn't answer:

| Files | What they hold                                                                                                       |
| ----- | -------------------------------------------------------------------------------------------------------------------- |
| 6 MKV | H.264, one HEVC; E-AC-3 5.1 or 2.0, up to 13 sound tracks in as many languages; 9 to 39 SubRip subtitles             |
| 7 MP4 | H.264 with AAC, AC-3 or up to 13 E-AC-3 tracks; one with 32 subtitles; cover art and data tracks next to the picture |
| 3 AVI | MPEG-4 Part 2 with MP3 or AC-3                                                                                       |
| 1 TS  | H.264 with AAC                                                                                                       |

Probing took 0.4 to 5.5 s and read 0.1 to 31 MB; the slowest were MP4 files that keep their index at the end.

Two designs were tried in Electron against these formats:

1. **Chromium plays the file.** Fastest: 135 ms to picture for MKV, 267 ms for MP4, 266 ms to seek. But Chromium exposes no sound track list, shows no embedded subtitles, and doesn't play E-AC-3 on Linux or AVI anywhere.
2. **ffmpeg repackages from the chosen position** into fragmented MP4 for Media Source Extensions, with the chosen sound track, and WebVTT for the chosen subtitles. Picture after 0.6 s from the start and 0.7 to 0.8 s from further in; paused, nothing more is read. Video is copied unless the player can't decode it, so the CPU cost is the sound.

The second shipped, as the one path for every title: track choice and subtitles are the point of the feature, and a second path for the files Chromium plays would double the seeking, track and subtitle work for half a second at start. With the whole design in place, the fake provider's titles start in 1.1 s and seek outside the buffer in 0.9 s ([architecture](architecture.md#movies-and-episodes)). On real hardware, time to picture depends mostly on the provider: its redirect, and the 1 to 3 range requests the probe needs.

libmpv stays the fallback if a format turns up that this can't handle; none has in the sample.

## Subtitles beyond text

Mr. Streamer shows every subtitle format a stream carries: PGS (Blu-ray), DVD and DivX pictures, DVB subtitles, teletext pages and closed captions (CEA-608), on live channels as well as in movies and episodes. Two ways to show pictures were compared on a 1080p H.264 file with PGS subtitles, using the bundled ffmpeg:

| Design                                                    | CPU for 6 s of 1080p | Picture              |
| --------------------------------------------------------- | -------------------- | -------------------- |
| Draw over the untouched picture, subtitles sent beside it | 0.04 s               | Copied, as before    |
| Burn into the picture: ffmpeg's overlay, then H.264 again | 6.55 s               | Re-encoded at CRF 21 |

Burning in costs more than a core for as long as the subtitles are on, and turns every copied picture into a converted one, with its quality loss and slower start. Drawing leaves the picture alone; the side output adds nothing measurable to a run's start (174 to 176 ms on the fake provider with and without it).

Decoding was the second choice. ffmpeg decodes PGS, DVD and DVB pictures itself, and teletext only through libzvbi, which needs iconv on Windows; CEA-608 inside a live picture needs the whole picture decoded first. And live channels play through mpegts.js, not ffmpeg: it passes teletext and DVB packets on with times on the player's clock, but not the SEI messages captions travel in. So the app decodes them itself (`@mrstreamer/core/subtitles`), in TypeScript, from what ffmpeg and mpegts.js hand over: DVB, teletext, PGS and CEA-608. No library joins the bundle; ffmpeg gains the DVD and DivX decoders, the DVB subtitle encoder, the `sup` muxer and `filter_units`, about 0.3 MB. The fixtures check each decoder against ffmpeg's and libzvbi's reading of the same data, including a national character set.

Not measured yet: real broadcasts with teletext and captions, and PGS from real Blu-ray rips, on the Mac and Windows; decoding cost on a slow machine, though a picture is decoded once per change and the canvas is only drawn then.
