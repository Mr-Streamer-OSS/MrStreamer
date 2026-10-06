// The foot of every page while a receiver on the network is connected: where playback goes, what
// plays there, a few controls, Stop and Play here. What plays is a button back to its controls in
// Watch or the title's view. With nothing playing the bar says so, and Disconnect lets the
// receiver go. Pages and the details sheet end above it (see `useReceiverBar`).
import { useQuery } from "@tanstack/react-query";
import { Airplay, Cast, ChevronDown, ChevronUp, Pause, Play, Square } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { Receiver } from "@mrstreamer/contracts/output";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import { openWatch, useUi } from "../../app/ui-store.ts";
import { Progress } from "../../components/Progress.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Tooltip } from "../../components/ui/tooltip.tsx";
import { queries } from "../../lib/queries.ts";
import { clock } from "../../lib/titles.ts";
import { useLiveSession, useTitleSession } from "../../player/media-session.ts";
import { outputs, receiverName, useOutput, where } from "../../player/output.ts";
import { player, receiverState, usePlayer } from "../../player/player.ts";
import { titlePlayer, useTitlePlayer, type NowPlaying } from "../../player/title-player.ts";
import { adjacentChannel, useListChannels } from "../live/lists.ts";
import { PlayHere, playHere, receiverProblem } from "./Output.tsx";
import { failureLine } from "./problems.ts";

/** How tall the bar is: 49 px in the smallest window. */
const HEIGHT = "3.5rem";

/**
 * Whether the bar shows: a receiver is connected, or was until its connection broke. While it
 * does, `--receiver-bar` is its height, which pages and sheets leave free at their foot.
 */
export function useReceiverBar(): boolean {
  const shows = useOutput(
    (state) => state.status.output.kind === "receiver" || state.status.output.kind === "lost",
  );
  useEffect(() => {
    document.documentElement.style.setProperty("--receiver-bar", shows ? HEIGHT : "0px");
  }, [shows]);
  return shows;
}

/** Opens the playing title's view again, over whatever page or sheet shows. */
function showTitle(): void {
  useUi.setState({ playingTitle: true, searchOpen: false, settings: null });
}

export function ReceiverBar() {
  const output = useOutput((state) => state.status.output);
  const title = useTitlePlayer((state) => (state.shows !== null ? state.now : null));
  // Nothing plays here while a receiver is connected, so a channel that isn't idle is its own.
  const channel = usePlayer((state) => (state.phase.kind === "idle" ? null : state.channel));
  if (output.kind !== "receiver" && output.kind !== "lost") return null;
  const { receiver } = output;
  return (
    <div
      role="region"
      aria-label={`Playing ${where(receiver)}`}
      className="fixed inset-x-0 bottom-0 z-[25] flex h-14 items-center gap-4 border-t border-white/10 bg-black pr-4 pl-6 text-sm"
    >
      <span className="flex flex-none items-center gap-2 text-[0.8125rem] text-muted-foreground">
        {receiver.kind === "airplay" ? <Airplay className="size-4" /> : <Cast className="size-4" />}
        {receiverName(receiver)}
      </span>
      {title ? (
        <TitleOn now={title} receiver={receiver} />
      ) : channel ? (
        <ChannelOn channel={channel} />
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {output.kind === "lost"
              ? "Connection lost"
              : output.media
                ? "Playing"
                : "Nothing playing"}
          </span>
          <Controls>
            {output.kind === "receiver" && output.media && (
              <Tooltip label="Stop">
                <Button size="icon-sm" aria-label="Stop" onClick={() => outputs.stop()}>
                  <Square className="fill-current" />
                </Button>
              </Tooltip>
            )}
            <Button size="sm" onClick={() => void outputs.local()}>
              Disconnect
            </Button>
          </Controls>
        </>
      )}
    </div>
  );
}

/** What plays, as a button back to its controls: its name, and what there is to say of it. */
function Playing({ name, detail, onOpen }: { name: string; detail: string; onOpen: () => void }) {
  return (
    <button
      onMouseDown={(event) => event.preventDefault()}
      onClick={onOpen}
      className="min-w-0 flex-initial truncate text-left hover:text-white"
    >
      <span className="font-semibold">{name}</span>
      {detail && <span className="text-muted-foreground"> · {detail}</span>}
    </button>
  );
}

function Controls({ children }: { children: ReactNode }) {
  return <div className="flex flex-none items-center gap-1.5">{children}</div>;
}

/** A movie or episode on the receiver: how far it is, pause, Stop and Play here. */
function TitleOn({ now, receiver }: { now: NowPlaying; receiver: Receiver }) {
  const phase = useTitlePlayer((state) => state.phase);
  const position = useTitlePlayer((state) => state.position);
  const duration = useTitlePlayer((state) => state.duration);
  // The system's media controls stay with the title while its view is closed.
  useTitleSession();
  const state =
    phase.kind === "failed"
      ? phase.problem.kind === "receiver"
        ? receiverProblem(phase.problem.failure, phase.problem.lost, receiver, null).title
        : "Didn't play"
      : phase.kind === "ended"
        ? "Finished"
        : phase.kind === "opening" || phase.kind === "starting"
          ? "Loading"
          : phase.kind === "reconnecting"
            ? "Reconnecting"
            : null;
  const playing = phase.kind === "playing";
  return (
    <>
      <Playing
        name={now.name}
        detail={[now.detail, state].filter(Boolean).join(" · ")}
        onOpen={showTitle}
      />
      {duration ? (
        <>
          <span className="flex-none text-[0.8125rem] tabular-nums">{clock(position)}</span>
          <Progress value={Math.min(1, position / duration)} className="min-w-12 flex-1" />
          <span className="flex-none text-[0.8125rem] text-muted-foreground tabular-nums">
            -{clock(duration - position)}
          </span>
        </>
      ) : (
        <span className="flex-1" />
      )}
      <Controls>
        <Tooltip label={playing ? "Pause" : "Play"}>
          <Button
            variant="primary"
            size="icon-sm"
            aria-label={playing ? "Pause" : "Play"}
            onClick={() => titlePlayer.togglePause()}
          >
            {playing ? <Pause className="fill-current" /> : <Play className="fill-current" />}
          </Button>
        </Tooltip>
        <Tooltip label="Stop">
          <Button size="icon-sm" aria-label="Stop" onClick={() => titlePlayer.stop()}>
            <Square className="fill-current" />
          </Button>
        </Tooltip>
        <PlayHere
          size="sm"
          onPlay={() => {
            // It plays here in its view, which the bar isn't.
            showTitle();
            playHere();
          }}
        />
      </Controls>
    </>
  );
}

/**
 * A channel on the receiver: what's on, what the receiver said of it unless it plays, or why it
 * doesn't, in the words Watch has for it, channel up and down, Stop and Play here.
 */
function ChannelOn({ channel }: { channel: LiveChannel }) {
  const phase = usePlayer((state) => state.phase);
  const list = useUi((state) => state.list);
  const channels = useListChannels(list).channels;
  const programme =
    useQuery(queries.listings([channel])).data?.[ownedKey(channel)]?.now?.title ?? null;
  // The system's media controls stay with the channel while Watch is closed.
  useLiveSession(channel);
  const said = receiverState(phase);
  const state =
    phase.kind === "failed"
      ? failureLine(phase, channel)
      : phase.kind === "tuning" || said === "loading"
        ? "Loading"
        : phase.kind === "reconnecting"
          ? "Reconnecting"
          : said === "paused"
            ? "Paused"
            : said === "buffering"
              ? "Buffering"
              : null;
  const step = (direction: number) => {
    const target = adjacentChannel(channels ?? [], channel, direction);
    if (target) player.zap(target);
  };
  return (
    <>
      <Playing
        name={programme ?? channel.title}
        detail={[programme && channel.title, state].filter(Boolean).join(" · ")}
        onOpen={openWatch}
      />
      <span className="flex-1" />
      <Controls>
        <Tooltip label="Channel up">
          <Button size="icon-sm" aria-label="Channel up" onClick={() => step(-1)}>
            <ChevronUp />
          </Button>
        </Tooltip>
        <Tooltip label="Channel down">
          <Button size="icon-sm" aria-label="Channel down" onClick={() => step(1)}>
            <ChevronDown />
          </Button>
        </Tooltip>
        <Tooltip label="Stop">
          <Button size="icon-sm" aria-label="Stop" onClick={() => player.stop()}>
            <Square className="fill-current" />
          </Button>
        </Tooltip>
        <PlayHere
          size="sm"
          onPlay={() => {
            // It plays here in Watch, with its sound.
            openWatch();
            playHere();
          }}
        />
      </Controls>
    </>
  );
}
