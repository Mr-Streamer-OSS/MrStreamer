# Recordings

## Sub-features

Record now from Live TV's now strip: a popover with the programme and channel, stop choices (**When it ends**, two minutes after the guide's end, only while the guide lists one; **In 1 hour**; **In 2 hours**), how many of the subscription's connections are in use, Cancel and **Start recording**. When every connection is held it says **Every connection is in use.**; when only playing here holds them it offers **Stop playing and record**, which stops the preview and starts with `stopPlaying`. While the channel records the strip's button reads **Recording** and opens Recordings. The window bar lists **Recordings** once any recording is kept. The Recordings page has **Now** and **Recorded**: title, channel and when, a bar of captured against planned minutes, the outcome word (Recording, Complete, Stopped, Partial, Missing) and why, the size, **Stop** for one that records, Play and a menu with **Delete** for an ended one, and a footer line. Under 1024 px the size joins the second line and the outcome, with its minutes, goes under the bar.

Scheduling, repeats, padding, storage, gaps, quitting and updates while recording belong to later cards.

## How to get to it (user POV)

Live TV, with a channel previewing: **Record** after the list/grid switch. Recordings: the window bar's **Recordings**, or the strip's **Recording**. An ended recording plays in the title player from this computer, as a downloaded copy does.

## Driving it with Electron CDP

Run `xvfb-run -a pnpm verify:desktop recordings` after `pnpm build` (source `scripts/recordings.ts`). The fake provider allows one connection and gives the playable test channels half-hour programmes. The scenario plays TEST | H.264 + AAC from Search, opens Live TV at 1280 × 800, opens Record (`record-popover`), starts and requires the busy answer with no recording made (`record-busy`), presses **Stop playing and record** until it records (`live-recording`), opens Recordings (`recordings-now`), records 8 seconds and stops it, starts a second recording, and captures the page with both sections (`recordings-1280`, `recordings-960`). It then plays the stopped one to 1 s of decoded picture and sound (`recording-playing`), deletes it from its menu and stops the second (`recordings-end`). `proof.json` holds `recordings.list` reads and the provider's stream counts.

## Gotchas

The first **Stop playing and record** can answer that the provider refused the stream: main's start can reach the provider before it has let go of the stopped preview's stream. The scenario records that answer as `stopPlayingFirstAnswer`, captures `record-refused` and presses again.
