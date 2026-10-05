// What the picture area says when there is no picture: idle, tuning, reconnecting or failed. A
// quality chosen for the channel that fails says so, and offers another instead of playing it.
// While a receiver on the network plays the channel there is never a picture here: the same place
// says what the receiver last confirmed of it and where, paused and buffering included, and always
// offers Play here.
import { useQuery } from "@tanstack/react-query";
import { Play, RotateCw, SkipForward } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { useUi } from "../../app/ui-store.ts";
import { ChannelLogo } from "../../components/ChannelLogo.tsx";
import { Button } from "../../components/ui/button.tsx";
import { describeError } from "../../lib/errors.ts";
import { outputs, useOutput, where } from "../../player/output.ts";
import { qualityName } from "../../lib/quality.ts";
import { queries, useChooseQuality } from "../../lib/queries.ts";
import { player, receiverState, usePlayer, type PlaybackProblem } from "../../player/player.ts";
import { PlayHere, ReceiverLine, receiverProblem } from "./Output.tsx";
import { useChannelQuality } from "./quality.ts";

interface Message {
  readonly title: string;
  readonly body?: ReactNode;
  readonly actions?: ReactNode;
}

export function PlaybackState({
  channel,
  onWatch,
  onNext,
}: {
  channel: LiveChannel;
  onWatch: () => void;
  onNext: () => void;
}) {
  const phase = usePlayer((state) => state.phase);
  const quality = useChannelQuality(channel);
  const chooseQuality = useChooseQuality();
  const playlist = useQuery(queries.subscription()).data?.kind === "m3u";
  const output = useOutput((state) => state.status.output);
  if (output.kind === "receiver" || output.kind === "lost") {
    const { receiver } = output;
    const on = where(receiver);
    if (phase.kind === "failed") {
      const { problem } = phase;
      const failed =
        problem.kind === "receiver"
          ? receiverProblem(problem.failure, problem.lost, receiver, null)
          : null;
      const provider = failed ? null : problemMessage(problem, channel, onNext, playlist);
      return (
        <Block
          title={failed?.title ?? provider?.title ?? ""}
          body={failed?.body ?? provider?.body}
          actions={
            <>
              {failed
                ? failed.retry && (
                    <Button
                      variant="primary"
                      onClick={() =>
                        problem.kind === "receiver" && problem.lost
                          ? outputs.reconnect()
                          : player.retry()
                      }
                    >
                      <RotateCw />
                      Try again
                    </Button>
                  )
                : provider?.actions}
              <PlayHere />
            </>
          }
        />
      );
    }
    if (phase.kind === "reconnecting") {
      return (
        <Block
          title="Connection lost"
          body={`Reconnecting to ${channel.title}, attempt ${phase.attempt} of ${phase.of}.`}
          actions={
            <>
              <Button variant="ghost" onClick={() => player.stop()}>
                Stop
              </Button>
              <PlayHere />
            </>
          }
        />
      );
    }
    // The receiver's own word once it started the channel: its remote pauses what the app can't.
    const said = receiverState(phase);
    return (
      <Block
        line={
          <ReceiverLine receiver={receiver}>
            {phase.kind === "idle"
              ? "Stopped"
              : phase.kind === "tuning" || said === "loading"
                ? "Loading"
                : said === "paused"
                  ? "Paused"
                  : said === "buffering"
                    ? "Buffering"
                    : "Playing"}{" "}
            {on}
          </ReceiverLine>
        }
        body={
          phase.kind === "tuning" ? (
            <Elapsed since={phase.since} what={`Tuning ${channel.title}`} />
          ) : undefined
        }
        actions={
          <>
            {phase.kind === "idle" && (
              <Button variant="primary" onClick={onWatch}>
                <Play className="fill-current" />
                Watch
              </Button>
            )}
            <PlayHere />
          </>
        }
      />
    );
  }
  if (phase.kind === "playing") return null;

  let message: Message;
  if (phase.kind === "idle") {
    message = {
      title: channel.title,
      actions: (
        <>
          <Button variant="primary" size="lg" onClick={onWatch}>
            <Play className="fill-current" />
            Watch
          </Button>
        </>
      ),
    };
  } else if (phase.kind === "tuning") {
    message = {
      title: channel.title,
      body: <Elapsed since={phase.since} />,
      actions: (
        <Button variant="ghost" onClick={() => player.stop()}>
          Cancel
        </Button>
      ),
    };
  } else if (phase.kind === "reconnecting") {
    message = {
      title: "Connection lost",
      body: `Reconnecting to ${channel.title}, attempt ${phase.attempt} of ${phase.of}.`,
      actions: (
        <Button variant="ghost" onClick={() => player.stop()}>
          Stop
        </Button>
      ),
    };
  } else if (quality.chosen && !["refused", "app"].includes(phase.problem.kind)) {
    // The chosen quality stays chosen: no other stream plays without asking.
    const chosen = qualityName(quality.chosen);
    const { alternative } = quality;
    message = {
      title: `${chosen} didn't start`,
      body: `${channel.title}'s ${chosen} stream failed. Your choice stays ${chosen} for this channel.`,
      actions: (
        <>
          <Button variant="primary" onClick={() => player.retry()}>
            <RotateCw />
            Retry
          </Button>
          {alternative && (
            <Button variant="secondary" onClick={() => chooseQuality(channel, alternative.id)}>
              {qualityName(alternative)}
            </Button>
          )}
          <Button variant="secondary" onClick={() => chooseQuality(channel, null)}>
            Automatic
          </Button>
        </>
      ),
    };
  } else {
    message = problemMessage(phase.problem, channel, onNext, playlist);
  }

  return (
    <div className="pointer-events-auto flex max-w-[34rem] flex-col items-center px-8 text-center">
      <ChannelLogo channel={channel} className="mb-6 h-14 w-20" />
      <h2 className="text-3xl font-semibold tracking-tight text-balance">{message.title}</h2>
      {message.body && (
        <p className="mt-3 text-[0.9375rem] leading-relaxed text-muted-foreground">
          {message.body}
        </p>
      )}
      {message.actions && <div className="mt-7 flex items-center gap-3">{message.actions}</div>}
    </div>
  );
}

/** A problem in a few words, as the mini player says it. */
export function problemTitle(problem: PlaybackProblem, channel: LiveChannel): string {
  return problemMessage(problem, channel, () => {}, false).title;
}

/** What a failed channel says; `playlist` for a channel of a playlist subscription. */
function problemMessage(
  problem: PlaybackProblem,
  channel: LiveChannel,
  onNext: () => void,
  playlist: boolean,
): Message {
  const retry = (
    <Button variant="primary" onClick={() => player.retry()}>
      <RotateCw />
      Retry
    </Button>
  );
  const next = (
    <Button variant="secondary" onClick={onNext}>
      <SkipForward />
      Next channel
    </Button>
  );
  switch (problem.kind) {
    case "unavailable":
      return {
        title: "Channel unavailable",
        body: `The provider has no stream for ${channel.title} right now.`,
        actions: (
          <>
            {retry}
            {next}
          </>
        ),
      };
    case "refused":
      return {
        title: "Stream refused",
        // Public playlists list channels that refuse viewers outside their country.
        body: playlist
          ? "It may not be offered in your country."
          : "The provider refused this stream. Another device may be using your connection.",
        actions: (
          <>
            {retry}
            {next}
          </>
        ),
      };
    case "unsupported":
      return {
        title: "Can't play this channel",
        body: `Its stream uses a format Mr. Streamer can't play yet. ${problem.detail}`,
        actions: next,
      };
    case "network":
      return {
        title: "Couldn't reconnect",
        body: `The stream stopped and reconnecting did not help. ${problem.detail}`,
        actions: (
          <>
            {retry}
            {next}
          </>
        ),
      };
    case "provider-error":
      return {
        title: "Provider error",
        body: `The provider answered with HTTP ${problem.status}.`,
        actions: retry,
      };
    case "receiver": {
      const failed = receiverProblem(problem.failure, problem.lost, outputs.receiver(), null);
      return { title: failed.title, body: failed.body };
    }
    case "app":
      return {
        title: "Can't open this channel",
        body: describeError(problem.error),
        actions:
          problem.error.kind === "invalid-login" ? (
            <Button variant="primary" onClick={() => useUi.setState({ editingLogin: true })}>
              Update login
            </Button>
          ) : (
            retry
          ),
      };
  }
}

/** "Tuning · 3 s", updated once a second. */
function Elapsed({ since, what = "Tuning" }: { since: number; what?: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <>
      {what} · {Math.max(0, Math.floor((now - since) / 1000))} s
    </>
  );
}

/** What a receiver's state says where the picture would be: a line or a title, a body, actions. */
function Block({
  line,
  title,
  body,
  actions,
}: {
  line?: ReactNode;
  title?: string;
  body?: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className="pointer-events-auto flex max-w-[34rem] flex-col items-center px-8 text-center">
      {line}
      {title && <h2 className="text-3xl font-semibold tracking-tight text-balance">{title}</h2>}
      {body && (
        <p className="mt-3 text-[0.9375rem] leading-relaxed text-muted-foreground">{body}</p>
      )}
      <div className="mt-5 flex items-center gap-3">{actions}</div>
    </div>
  );
}
