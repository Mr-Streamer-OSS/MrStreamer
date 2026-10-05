// Taking up what a receiver already plays when the window opens, as after closing it on macOS:
// the main process kept it playing, and the window shows its controls again.
import type { QueryClient } from "@tanstack/react-query";
import { call } from "../lib/ipc.ts";
import { queries } from "../lib/queries.ts";
import { movieNow } from "../lib/titles.ts";
import { player } from "../player/player.ts";
import { episodeNow, titlePlayer, type NowPlaying } from "../player/title-player.ts";
import { openWatch, useUi } from "./ui-store.ts";

/**
 * Shows Watch or the title's view on what the receiver plays, with the receiver's own word on
 * it. Does nothing when it plays nothing, or plays what the lists no longer hold.
 */
export async function showReceiverPlayback(client: QueryClient): Promise<void> {
  const { output } = await call("output.status");
  const media = output.kind === "receiver" ? output.media : null;
  if (!media) return;
  if (media.item.kind === "channel") {
    const [channel] = await client.fetchQuery(queries.channelsById([media.item.channelId]));
    if (!channel) return;
    player.adopt(channel, media);
    openWatch();
    return;
  }
  const playing = await call("output.playingTitle");
  if (!playing) return;
  const ref = playing.title.title;
  let now: NowPlaying | null = null;
  if (ref.kind === "movie") {
    const [title] = await client.fetchQuery(queries.titles("movie", [ref.id]));
    now = title ? movieNow({ ...title, id: ref.id }, title.backdropUrl) : null;
  } else {
    const series = await client.fetchQuery(queries.details("series", ref.seriesId));
    const episode =
      series.kind === "series"
        ? series.seasons
            .flatMap((season) => season.episodes)
            .find((each) => each.season === ref.season && each.number === ref.episode)
        : undefined;
    now = series.kind === "series" && episode ? episodeNow(series, episode) : null;
  }
  if (!now) return;
  titlePlayer.adopt(
    now,
    {
      sessionId: playing.title.sessionId,
      duration: playing.title.duration,
      audio: playing.title.audio,
      subtitles: playing.title.subtitles,
      shows: playing.title.shows,
      audioId: playing.audio,
      subtitleId: playing.subtitle,
    },
    media,
  );
  useUi.setState({ playingTitle: true });
}
