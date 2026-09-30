# Playback evaluation

How the playback design was chosen, measured on real streams. The [architecture](architecture.md#playback) describes the design itself.

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

1. **Chromium alone**: mpegts.js into Chromium's decoders, the slice 01 player.
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

libmpv stays the option for movies and series, if subtitles and seeking need more than Chromium offers. The `Engine` boundary in `apps/desktop/src/renderer/src/player/engine.ts` leaves room for it.

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
