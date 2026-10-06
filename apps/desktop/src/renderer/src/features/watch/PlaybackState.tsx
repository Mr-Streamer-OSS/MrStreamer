// What the picture area says when there is no picture: idle, tuning, reconnecting or failed. A
// failure says what went wrong, what was observed of it in a small line, and offers what can help
// (see problems.ts for the words): Retry opens the same channel again in the quality it had,
// Quality opens the quality menu and starts nothing, Channels opens the list. A quality chosen for
// the channel stays chosen when its stream fails: another one, or Automatic, plays only when
// picked. A refusal offers neither. Its status names no cause, so nothing shows another quality
// would be let through.
// While a receiver on the network plays the channel there is never a picture here: the same place
// says what the receiver last confirmed of it and where, paused and buffering included, and always
// offers Play here. A channel that failed there keeps saying so under that receiver's name while
// it is reached again, or another in its place.
import { useQuery } from "@tanstack/react-query";
import { Play, RotateCw, SkipForward } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { useUi } from "../../app/ui-store.ts";
import { ChannelLogo } from "../../components/ChannelLogo.tsx";
import { Button } from "../../components/ui/button.tsx";
import { outputs, useOutput, where } from "../../player/output.ts";
import { qualityName } from "../../lib/quality.ts";
import { queries, useChooseQuality } from "../../lib/queries.ts";
import { cn } from "../../lib/utils.ts";
import { player, receiverState, usePlayer } from "../../player/player.ts";
import { PlayHere, ReceiverLine } from "./Output.tsx";
import {
  canRetry,
  failureCopy,
  failureEvidence,
  isStreamsOwn,
  reconnectingCopy,
  triedStreams,
  type FailedPhase,
  type ReconnectingPhase,
  type Tried,
} from "./problems.ts";
import { useChannelQuality } from "./quality.ts";

interface Message {
  readonly title: string;
  readonly body?: ReactNode;
  /** What was observed, in a small line of its own under the body. */
  readonly evidence?: ReactNode;
  readonly actions?: ReactNode;
}

/** A channel's trouble in words: a reconnect's or a failure's, and what its last try got to. */
interface Trouble {
  readonly title: string;
  readonly body: string;
  /** Empty when there is nothing to add. */
  readonly evidence: string;
  readonly tried: Tried | null;
}

/** What `channel` says while it reconnects or once it failed; null while it does neither. */
function useTrouble(channel: LiveChannel): Trouble | null {
  const phase = usePlayer((state) => state.phase);
  const stream = usePlayer((state) => state.stream);
  const quality = useChannelQuality(channel);
  const playlist = useQuery(queries.subscription()).data?.kind === "m3u";
  if (phase.kind === "reconnecting") {
    return { ...reconnectingCopy(channel), evidence: "", tried: null };
  }
  if (phase.kind !== "failed") return null;
  const chosen = quality.chosen && isStreamsOwn(phase.problem) ? qualityName(quality.chosen) : null;
  const tried = triedStreams(channel, stream);
  return {
    ...failureCopy(phase, channel, { chosen, playlist, tried }),
    evidence: failureEvidence(phase, channel, { chosen, tried }),
    tried,
  };
}

/**
 * R and Retry: tries the failed channel again where that can help, in the quality it had and with
 * every reconnect. A receiver whose connection broke is reached again instead. False when there
 * was nothing to try: the channel hasn't failed, or trying again wouldn't change the answer.
 */
export function retryFailed(): boolean {
  const { phase } = player.state();
  if (phase.kind !== "failed" || !canRetry(phase.problem)) return false;
  if (phase.problem.kind === "receiver") {
    // One connect at a time.
    if (outputs.status().output.kind === "connecting") return false;
    if (phase.problem.lost) outputs.reconnect();
    else player.retry();
  } else player.retry();
  return true;
}

/**
 * Says a channel's trouble to a screen reader, once: the title and sentence of a reconnect or a
 * failure. It stays in the page, empty, while the channel plays, so the words are a change it
 * reads out. Which attempt a reconnect is at, and the seconds to it, aren't in it, so they
 * interrupt nobody.
 */
export function PlaybackAnnouncement({ channel }: { channel: LiveChannel }) {
  const trouble = useTrouble(channel);
  return (
    <div role="status" className="sr-only">
      {trouble && `${trouble.title}. ${trouble.body}`}
    </div>
  );
}

export function PlaybackState({
  channel,
  onWatch,
  onNext,
  onQuality,
  onChannels,
}: {
  channel: LiveChannel;
  onWatch: () => void;
  onNext: () => void;
  /** Opens the quality menu. */
  onQuality: () => void;
  /** Opens the channel list. */
  onChannels: () => void;
}) {
  const phase = usePlayer((state) => state.phase);
  const trouble = useTrouble(channel);
  const output = useOutput((state) => state.status.output);
  const connectingFrom = useOutput((state) => state.connectingFrom);
  // The connect under way names the receiver it reaches, which need not be the one that failed.
  const receiver =
    output.kind === "receiver" || output.kind === "lost"
      ? output.receiver
      : phase.kind === "failed" && phase.problem.kind === "receiver"
        ? connectingFrom
        : null;
  const channels = (
    <Button variant="secondary" onClick={onChannels}>
      Channels
    </Button>
  );
  const troubled: Message | null =
    trouble && phase.kind === "failed"
      ? {
          title: trouble.title,
          body: trouble.body,
          evidence: trouble.evidence,
          actions: (
            <FailureActions
              failed={phase}
              channel={channel}
              tried={trouble.tried}
              onNext={onNext}
              onQuality={onQuality}
              channels={channels}
            />
          ),
        }
      : trouble && phase.kind === "reconnecting"
        ? {
            title: trouble.title,
            body: trouble.body,
            evidence: <Attempts phase={phase} />,
            actions: (
              <>
                <Button variant="ghost" onClick={() => player.stop()}>
                  Stop
                </Button>
                {channels}
              </>
            ),
          }
        : null;
  if (receiver) {
    const on = where(receiver);
    if (troubled) {
      return (
        <Block
          title={troubled.title}
          body={troubled.body}
          evidence={troubled.evidence}
          actions={
            <>
              {troubled.actions}
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

  const message: Message =
    troubled ??
    (phase.kind === "tuning"
      ? {
          title: channel.title,
          body: <Elapsed since={phase.since} />,
          actions: (
            <Button variant="ghost" onClick={() => player.stop()}>
              Cancel
            </Button>
          ),
        }
      : {
          title: channel.title,
          actions: (
            <Button variant="primary" size="lg" onClick={onWatch}>
              <Play className="fill-current" />
              Watch
            </Button>
          ),
        });

  return (
    <div className="pointer-events-auto flex max-w-[34rem] flex-col items-center px-8 text-center">
      <ChannelLogo channel={channel} className="mb-6 h-14 w-20" />
      <h2 className="text-3xl font-semibold tracking-tight text-balance">{message.title}</h2>
      {message.body && (
        <p className="mt-3 text-[0.9375rem] leading-relaxed text-muted-foreground">
          {message.body}
        </p>
      )}
      {message.evidence && <Evidence>{message.evidence}</Evidence>}
      {message.actions && <div className="mt-7 flex items-center gap-3">{message.actions}</div>}
    </div>
  );
}

/**
 * What a failed channel offers, the likeliest to help first. Retry where trying again can change
 * the answer. Then, for a quality chosen for the channel whose stream failed, the quality
 * Automatic would start with and Automatic itself, each of which changes that choice only when
 * pressed. Otherwise Quality while the channel has a stream the last try didn't reach, and Next
 * channel when it has none. A refusal or a session that didn't open offers no other quality.
 * Channels comes last.
 */
function FailureActions({
  failed,
  channel,
  tried,
  onNext,
  onQuality,
  channels,
}: {
  failed: FailedPhase;
  channel: LiveChannel;
  tried: Tried | null;
  onNext: () => void;
  onQuality: () => void;
  channels: ReactNode;
}) {
  const { problem } = failed;
  const quality = useChannelQuality(channel);
  const chooseQuality = useChooseQuality();
  const connecting = useOutput((state) => state.status.output.kind === "connecting");
  if (problem.kind === "receiver") {
    return (
      canRetry(problem) &&
      !connecting && (
        <Button variant="primary" onClick={retryFailed}>
          <RotateCw />
          Try again
        </Button>
      )
    );
  }
  if (problem.kind === "app" && problem.error.kind === "invalid-login") {
    return (
      <>
        <Button variant="primary" onClick={() => useUi.setState({ editingLogin: true })}>
          Update login
        </Button>
        {channels}
      </>
    );
  }
  const retry = canRetry(problem) && (
    <Button variant="primary" onClick={retryFailed}>
      <RotateCw />
      Retry
    </Button>
  );
  if (!isStreamsOwn(problem)) {
    return (
      <>
        {retry}
        {channels}
      </>
    );
  }
  if (quality.chosen) {
    const { alternative } = quality;
    return (
      <>
        {retry}
        {alternative && (
          <Button
            variant={retry ? "secondary" : "primary"}
            onClick={() => chooseQuality(channel, alternative.id)}
          >
            {qualityName(alternative)}
          </Button>
        )}
        <Button variant="secondary" onClick={() => chooseQuality(channel, null)}>
          Automatic
        </Button>
        {!retry && channels}
      </>
    );
  }
  // Unknown counts as some left: the menu then says what there is.
  const untried = channel.variants.length > 1 && (tried === null || tried.untried > 0);
  return (
    <>
      {retry}
      {untried ? (
        <Button variant={retry ? "secondary" : "primary"} onClick={onQuality}>
          Quality
        </Button>
      ) : (
        <Button variant="secondary" onClick={onNext}>
          <SkipForward />
          Next channel
        </Button>
      )}
      {channels}
    </>
  );
}

/** The small line under a message's sentence: what was observed, or which reconnect is next. */
function Evidence({ children }: { children: ReactNode }) {
  return <p className="mt-2 text-[0.8125rem] text-muted-foreground tabular-nums">{children}</p>;
}

/**
 * Which reconnect a channel is at, of how many, with a dot for each, and the seconds until it
 * starts while it waits. The dots stand still: one fills per attempt.
 */
function Attempts({ phase }: { phase: ReconnectingPhase }) {
  return (
    <>
      <span aria-hidden className="mr-2 inline-flex gap-1 align-middle">
        {Array.from({ length: phase.of }, (_, index) => (
          <span
            key={index}
            className={cn(
              "size-1.5 rounded-full",
              index < phase.attempt ? "bg-white" : "bg-white/25",
            )}
          />
        ))}
      </span>
      attempt {phase.attempt} of {phase.of}
      {phase.until !== null && <Remaining until={phase.until} />}
    </>
  );
}

/** " in 4 s", counted down once a second until `until`. */
function Remaining({ until }: { until: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  return <> in {Math.max(1, Math.ceil((until - now) / 1000))} s</>;
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

/**
 * What a receiver's state says where the picture would be: a line or a title, a body, what was
 * observed, actions.
 */
function Block({
  line,
  title,
  body,
  evidence,
  actions,
}: {
  line?: ReactNode;
  title?: string;
  body?: ReactNode;
  evidence?: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className="pointer-events-auto flex max-w-[34rem] flex-col items-center px-8 text-center">
      {line}
      {title && <h2 className="text-3xl font-semibold tracking-tight text-balance">{title}</h2>}
      {body && (
        <p className="mt-3 text-[0.9375rem] leading-relaxed text-muted-foreground">{body}</p>
      )}
      {evidence && <Evidence>{evidence}</Evidence>}
      <div className="mt-5 flex items-center gap-3">{actions}</div>
    </div>
  );
}
