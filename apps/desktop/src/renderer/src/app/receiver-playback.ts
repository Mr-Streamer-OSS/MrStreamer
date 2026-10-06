// Taking up what a receiver already plays when the page starts, as after a reload: the main
// process kept it playing, and the window shows its controls again. A window closed on macOS
// while a receiver plays keeps its page, so it has nothing to take up.
//
// The lists say what it is, and they take a while: the receiver may let go of it, lose its
// connection or get something else to play meanwhile, and the pages may make way for the login
// form. So what is taken up is what the receiver still plays once the lists answered, as it has
// it by then, and never what it played when they were asked.
import type { QueryClient } from "@tanstack/react-query";
import { seriesOf } from "@mrstreamer/contracts/ondemand";
import type { RemoteMedia } from "@mrstreamer/contracts/output";
import { ownedId } from "@mrstreamer/contracts/subscription";
import { call } from "../lib/ipc.ts";
import { queries } from "../lib/queries.ts";
import { movieNow } from "../lib/titles.ts";
import { outputs } from "../player/output.ts";
import { player } from "../player/player.ts";
import { episodeNow, titlePlayer, type NowPlaying } from "../player/title-player.ts";
import { openWatch, useUi } from "./ui-store.ts";

/**
 * Shows Watch or the title's view on what the receiver plays, with the receiver's latest word on
 * it. Does nothing when it plays nothing, plays what the lists no longer hold, or no longer plays
 * it once they answered. `signal` aborts when the pages go, after which nothing is taken up.
 */
export async function showReceiverPlayback(
  client: QueryClient,
  signal: AbortSignal,
): Promise<void> {
  const { account } = useUi.getState();
  const { output } = await call("output.status");
  if (output.kind !== "receiver" || !output.media) return;
  const { receiver, media: began } = output;
  /**
   * The receiver's latest word on the load it played then, or null once that isn't the window's
   * to take up: the pages went, the account changed, the viewer played something here, or the
   * receiver plays it no more. That last is read from the status the players follow, so they
   * hear of whatever becomes of a load taken up.
   */
  const latest = (): RemoteMedia | null => {
    if (signal.aborted || useUi.getState().account !== account) return null;
    if (titlePlayer.state().now || player.state().phase.kind !== "idle") return null;
    const now = outputs.status().output;
    if (now.kind !== "receiver" || now.receiver.id !== receiver.id) return null;
    const media = now.media;
    return media?.generation === began.generation && media.sessionId === began.sessionId
      ? media
      : null;
  };
  if (began.item.kind === "channel") {
    const [channel] = await client.fetchQuery(queries.channelsOf([began.item.channel]));
    const media = latest();
    if (!channel || !media) return;
    player.adopt(channel, media);
    openWatch();
    return;
  }
  const playing = await call("output.playingTitle");
  // What its file holds is this load's only while the session is the same.
  if (playing?.title.sessionId !== began.sessionId || !latest()) return;
  const ref = playing.title.title;
  let now: NowPlaying | null = null;
  if (ref.kind === "movie") {
    const [title] = await client.fetchQuery(queries.titles("movie", [ref]));
    now = title ? movieNow({ ...title, ...ownedId(ref) }, title.backdropUrl) : null;
  } else {
    const series = await client.fetchQuery(queries.details("series", seriesOf(ref)));
    const episode =
      series.kind === "series"
        ? series.seasons
            .flatMap((season) => season.episodes)
            .find((each) => each.season === ref.season && each.number === ref.episode)
        : undefined;
    now = series.kind === "series" && episode ? episodeNow(series, episode) : null;
  }
  const media = latest();
  if (!now || !media) return;
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
