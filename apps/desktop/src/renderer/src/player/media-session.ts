// System media controls: what macOS's Now Playing, Windows' media overlay and Linux's MPRIS show
// for what plays, and what their buttons and the keyboard's media keys do. Chromium hands
// `navigator.mediaSession` on to each.
//
// A movie or episode shows its name, its series and "S1 E3", and its TMDB artwork, and takes play,
// pause, 10 s back and forward, seeking and, when there is one, the next episode. A channel shows
// the programme, the channel and its logo, and takes only play and stop: a headphone's double tap
// must never change channel. Pausing a channel stops it, and Chromium then has nothing playing to
// offer the system, so Watch in the app starts it again. Artwork must be http or https, or a data
// URL; Chromium refuses the app's own file:// pictures. Only Watch and a playing title present
// anything, so the muted previews leave the system alone.
//
// What a receiver on the network plays answers the same buttons, from what it last confirmed.
// Chromium shows the system a session only while the window itself plays sound, which it doesn't
// then, so the system's controls and the media keys reach the app only where the system still
// offers it.
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { queries } from "../lib/queries.ts";
import { player, usePlayer } from "./player.ts";
import { titlePlayer, useTitlePlayer } from "./title-player.ts";

/** How far the system's back and forward buttons skip when they don't say. */
const SKIP_S = 10;

const ACTIONS: readonly MediaSessionAction[] = [
  "play",
  "pause",
  "stop",
  "seekbackward",
  "seekforward",
  "seekto",
  "previoustrack",
  "nexttrack",
];

type Handlers = Partial<Record<MediaSessionAction, MediaSessionActionHandler>>;

/** The system's session, where Chromium has one. */
const session = "mediaSession" in navigator ? navigator.mediaSession : null;

/**
 * The view whose playback the system shows. Watch can open before a playing title has gone, so
 * a view that closes clears the session only while it is still its own.
 */
let owner: object | null = null;

/** Answers the actions in `handlers`; the system leaves out the rest. */
function answer(handlers: Handlers): void {
  for (const action of ACTIONS) {
    try {
      session?.setActionHandler(action, handlers[action] ?? null);
    } catch {
      // An action this Chromium doesn't know.
    }
  }
}

/** Shows `metadata` for `view`, which owns the session from now on. */
function present(view: object, metadata: MediaMetadataInit, handlers: Handlers): void {
  if (!session) return;
  owner = view;
  session.metadata = new MediaMetadata(metadata);
  answer(handlers);
}

/** Says whether `view`'s playback plays, while the session is its own. */
function showState(view: object, state: MediaSessionPlaybackState): void {
  if (session && owner === view) session.playbackState = state;
}

/** A view of its own, whose session ends when the view closes. */
function useView(): object {
  const view = useRef({}).current;
  useEffect(
    () => () => {
      if (!session || owner !== view) return;
      owner = null;
      session.metadata = null;
      answer({});
      session.playbackState = "none";
      session.setPositionState();
    },
    [view],
  );
  return view;
}

/** Artwork the system can load: http or https only. */
function artwork(url: string | null): MediaImage[] {
  return url && /^https?:\/\//.test(url) ? [{ src: url }] : [];
}

/**
 * The playing title in the system's controls. Next plays the next episode, as N does, and shows
 * only while the series has one.
 */
export function useTitleSession(): void {
  const now = useTitlePlayer((state) => state.now);
  const phase = useTitlePlayer((state) => state.phase.kind);
  const duration = useTitlePlayer((state) => state.duration);
  const hasNext = useTitlePlayer((state) => Boolean(state.next));
  const view = useView();

  useEffect(() => {
    if (!now) return;
    // An episode's detail reads "S1 E3 · Its name".
    const [label, ...name] = now.detail?.split(" · ") ?? [];
    const episode = now.title.kind === "episode";
    // On a receiver the element here plays nothing: whether it plays is the receiver's word.
    const paused = () =>
      titlePlayer.onReceiver()
        ? titlePlayer.state().phase.kind !== "playing"
        : player.element.paused;
    const pause = () => {
      if (!paused()) titlePlayer.togglePause();
    };
    present(
      view,
      {
        title: episode && name.length > 0 ? name.join(" · ") : now.name,
        artist: episode ? now.name : "",
        album: episode ? (label ?? "") : "",
        artwork: artwork(now.artworkUrl),
      },
      {
        play: () => {
          if (paused()) titlePlayer.togglePause();
        },
        pause,
        stop: pause,
        seekbackward: (details) => titlePlayer.skip(-(details.seekOffset ?? SKIP_S)),
        seekforward: (details) => titlePlayer.skip(details.seekOffset ?? SKIP_S),
        seekto: (details) => {
          if (details.seekTime !== undefined) titlePlayer.seek(details.seekTime);
        },
        ...(hasNext ? { nexttrack: () => titlePlayer.playNext() } : {}),
      },
    );
  }, [view, now, hasNext]);

  useEffect(() => showState(view, phase === "playing" ? "playing" : "paused"), [view, phase]);

  // Where the title is, whenever that jumps or its pace changes; the system counts on from there.
  useEffect(() => {
    if (!duration) return;
    const video = player.element;
    const update = () => {
      if (!session || owner !== view) return;
      if (!Number.isFinite(video.currentTime) || video.currentTime > duration) return;
      session.setPositionState({
        duration,
        position: video.currentTime,
        playbackRate: video.playbackRate || 1,
      });
    };
    update();
    const events = ["seeked", "ratechange", "play", "pause", "playing"] as const;
    for (const event of events) video.addEventListener(event, update);
    return () => {
      for (const event of events) video.removeEventListener(event, update);
    };
  }, [view, duration]);

  // On a receiver: where it said it was, whenever its state changes or a skip is on its way.
  const remote = useTitlePlayer((state) => state.shows !== null);
  const skipping = useTitlePlayer((state) => state.confirmed !== null);
  useEffect(() => {
    if (!remote || !duration || !session || owner !== view) return;
    const { position } = titlePlayer.state();
    session.setPositionState({
      duration,
      position: Math.min(Math.max(0, position), duration),
      playbackRate: 1,
    });
  }, [view, remote, duration, phase, skipping]);
}

/**
 * The channel in Watch in the system's controls: the programme on now, the channel and its logo.
 * Play starts a stopped channel, pause and stop stop it.
 */
export function useLiveSession(channel: LiveChannel | null): void {
  const phase = usePlayer((state) => state.phase.kind);
  const live = phase !== "idle" && phase !== "failed";
  const listings = useQuery(queries.listings(channel ? [channel.id] : []));
  const programme = (channel && listings.data?.[channel.id]?.now?.title) ?? null;
  const view = useView();

  useEffect(() => {
    if (!channel) return;
    const stop = () => player.stop();
    present(
      view,
      {
        title: programme ?? channel.title,
        artist: programme ? channel.title : "",
        artwork: artwork(channel.logoUrl),
      },
      {
        play: () => {
          const { phase: now } = player.state();
          if (now.kind === "idle" || now.kind === "failed") player.play(channel);
        },
        pause: stop,
        stop,
      },
    );
    // A channel has no position for the system to show.
    session?.setPositionState();
  }, [view, channel, programme]);

  useEffect(() => showState(view, live ? "playing" : "paused"), [view, live]);
}
