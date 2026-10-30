# Recordings

## Sub-features

Record now from Live TV's now strip: a popover with the programme and channel, stop choices (**When it ends**, two minutes after the guide's end, only while the guide lists one; **In 1 hour**; **In 2 hours**), how many of the subscription's connections are in use, Cancel and **Start recording**. When every connection is held it says **Every connection is in use.**; when only playing here holds them it offers **Stop playing and record**, which stops the preview and starts with `stopPlaying`. While the channel records the strip's button reads **Recording** and opens Recordings. The window bar lists **Recordings** once any recording is kept. The Recordings page has **Now** and **Recorded**: title, channel and when, a bar of captured against planned minutes, the outcome word (Recording, Complete, Stopped, Partial, Missing) and why, the size, **Stop** for one that records, Play and a menu with **Delete** for an ended one, and a footer line. Under 1024 px the size joins the second line and the outcome, with its minutes, goes under the bar.

Scheduling, repeats, padding, storage, gaps, quitting and updates while recording belong to later cards.

## How to get to it (user POV)

Live TV, with a channel previewing: **Record** after the list/grid switch. Recordings: the window bar's **Recordings**, or the strip's **Recording**. An ended recording plays in the title player from this computer, as a downloaded copy does.

## Driving it with Electron CDP

Run `xvfb-run -a pnpm verify:desktop recordings` after `pnpm build` (source `scripts/recordings.ts`). The fake provider allows one connection and gives the playable test channels half-hour programmes. The scenario plays TEST | H.264 + AAC from Search, opens Live TV at 1280 × 800, opens Record (`record-popover`), starts and requires the busy answer with no recording made (`record-busy`), requires the provider asked for nothing more, presses **Stop playing and record** and requires it records on the one connection (`live-recording`), opens Recordings (`recordings-now`), records 8 seconds and stops it, starts a second recording, and captures the page with both sections (`recordings-1280`, `recordings-960`). It then plays the stopped one to 1 s and requires a decoded picture and sound (`recording-playing`), deletes it from its menu and stops the second (`recordings-end`). After each Stop it requires the provider to count no open stream. `proof.json` holds `recordings.list` reads and the provider's stream counts.

What is captured, and its limits: the MPEG-TS packets as the provider sends them, every program, sound, subtitle and teletext track byte for byte, into one `.ts` file (`main/recordings/capture.ts`); nothing is decoded or re-encoded, so a recording keeps whatever codecs the channel sends and plays where the title player plays that channel's codecs. An HLS channel is read through playback's clear muxed MPEG-TS subset (`playback/hls-ts-input.ts`): its highest variant up to 1080p, its segments written one after another, discontinuities kept as sent. Encrypted, fragmented MP4, byte-range and separate-audio-rendition HLS, and a stream with no MPEG-TS program table, are refused before anything is kept. Records and files are in the data folder's `recordings/` (`recordings.json`, one folder per id); a viewer-chosen folder belongs to a later card.

Service contracts are in `apps/desktop/test/recordings.test.ts`: every track of the subtitles fixture recorded to its stop time and played through `openCopy`, busy without a provider request while Watch holds the one connection, **Stop playing and record** while the provider frees the stopped stream's slot late, beside Watch with two connections, stop and broken-stream partials, quit then restart, the next stream after one with no program, a name within the file system's bytes, and HLS segments with a refused separate-audio rendition.

Stop also retries saving an ended recording's current status. A failed terminal save never makes a later Stop silently succeed: it reports the save error while storage remains unavailable, then persists the retained outcome when storage works again. The public-service check blocks manifest replacement after start, lets the source end, and verifies failure, released connections and a successful retry against the file.

## Gotchas

A provider can take a moment to free the slot of the preview **Stop playing and record** just closed: capture asks again after 0.5 and 1.5 s when refused, as playback does.

Without a subscription saved the app shows Connect and standalone Downloads only: recordings are kept but not listed until one is added again.
