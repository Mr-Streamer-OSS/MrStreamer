import { appError } from "../../lib/errors.ts";
import { chosenChannelsQuery } from "../live/ChannelTable.tsx";
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
// A failure's message closes with its cross (CloseMessage.tsx). The picture area then says
// nothing; Watch and R still try the channel again.
//   A channel the viewer named fallback channels for (Paper A5) plays the first one not tried
// yet in its place when it fails for a reason another source can help with, and says which and
// from where. A refusal or a rate limit stops there, as does the end of its fallbacks, which then
// says that none of them played. Only the fallbacks of the channel the viewer chose count, never
// a fallback's own. The run ends once the viewer plays anything else.
import { useQueryClient } from "@tanstack/react-query";
import { Play, RotateCw, SkipForward } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { AppError } from "@mrstreamer/contracts/errors";
import { fallbackAfter, type LiveChannel } from "@mrstreamer/contracts/library";
import { ownedId, sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";
import { t } from "@mrstreamer/core/i18n";
import { openSubscription } from "../../app/ui-store.ts";
import { ChannelLogo } from "../../components/ChannelLogo.tsx";
import { Button } from "../../components/ui/button.tsx";
import { outputs, useOutput, where } from "../../player/output.ts";
import { qualityName } from "../../lib/quality.ts";
import {
  queries,
  subscriptionName,
  useChooseQuality,
  useSubscriptionNames,
  useSubscriptions,
} from "../../lib/queries.ts";
import { cn } from "../../lib/utils.ts";
import { player, receiverState, usePlayer, type PlaybackProblem } from "../../player/player.ts";
import { flashNote } from "./flash-state.ts";
import { CloseMessage, useClosed } from "./CloseMessage.tsx";
import { PlayHere, ReceiverLine } from "./Output.tsx";
import {
  canRetry,
  failureCopy,
  failureEvidence,
  isStreamsOwn,
  reconnectingCopy,
  triedStreams,
  type FailedPhase,
  type FailedSource,
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
  /** A failure, whose message the viewer can close. */
  readonly failure?: FailedPhase;
}

/** A channel's trouble in words: a reconnect's or a failure's, and what its last try got to. */
interface Trouble {
  readonly title: string;
  readonly body: string;
  /** Empty when there is nothing to add. */
  readonly evidence: string;
  readonly tried: Tried | null;
}

/** The subscription `channel` is of, as a failure's words name it; null once it isn't saved. */
function useFailedSource(channel: LiveChannel): FailedSource | null {
  const subscriptions = useSubscriptions();
  const owner = subscriptions.find((each) => each.id === channel.subscriptionId);

  return owner
    ? {
        name: subscriptionName(owner),
        playlist: owner.kind === "m3u",
        several: subscriptions.length > 1,
      }
    : null;
}

/** What `channel` says while it reconnects or once it failed; null while it does neither. */
function useTrouble(channel: LiveChannel): Trouble | null {
  const phase = usePlayer((state) => state.phase);
  const stream = usePlayer((state) => state.stream);
  const quality = useChannelQuality(channel);
  const source = useFailedSource(channel);

  if (phase.kind === "reconnecting") {
    return { ...reconnectingCopy(channel), evidence: "", tried: null };
  }

  if (phase.kind !== "failed") return null;
  const chosen = quality.chosen && isStreamsOwn(phase.problem) ? qualityName(quality.chosen) : null;
  const tried = triedStreams(channel, stream);

  return {
    ...failureCopy(phase, channel, { chosen, source, tried }),
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
  const fallback = useFallback(channel);
  const output = useOutput((state) => state.status.output);
  const connectingFrom = useOutput((state) => state.connectingFrom);
  const closed = useClosed(phase.kind === "failed" ? phase : null);

  // The connect under way names the receiver it reaches, which need not be the one that failed.
  const receiver =
    output.kind === "receiver" || output.kind === "lost"
      ? output.receiver
      : phase.kind === "failed" && phase.problem.kind === "receiver"
        ? connectingFrom
        : null;

  const channels = (
    <Button variant="secondary" onClick={onChannels}>
      {t("Channels")}
    </Button>
  );

  const troubled: Message | null =
    trouble && phase.kind === "failed"
      ? {
          title: trouble.title,
          body: trouble.body,
          evidence: trouble.evidence,
          failure: phase,
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
                  {t("Stop")}
                </Button>
                {channels}
              </>
            ),
          }
        : null;

  // Closed: nothing in its place, not even what a receiver said before the failure.
  if (closed) return null;

  if (receiver) {
    const on = where(receiver);

    if (troubled) {
      return (
        <Block
          title={troubled.title}
          body={troubled.body}
          evidence={troubled.evidence}
          failure={troubled.failure}
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
              ? t("Stopped {where}", { where: on })
              : phase.kind === "tuning" || said === "loading"
                ? t("Loading {where}", { where: on })
                : said === "paused"
                  ? t("Paused {where}", { where: on })
                  : said === "buffering"
                    ? t("Buffering {where}", { where: on })
                    : t("Playing {where}", { where: on })}
          </ReceiverLine>
        }
        body={
          phase.kind === "tuning" ? (
            <Elapsed since={phase.since} what={t("Tuning {name}", { name: channel.title })} />
          ) : undefined
        }
        actions={
          <>
            {phase.kind === "idle" && (
              <Button variant="primary" onClick={onWatch}>
                <Play className="fill-current" />
                {t("Watch")}
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
              {t("Cancel")}
            </Button>
          ),
        }
      : {
          title: channel.title,
          actions: (
            <Button variant="primary" size="lg" onClick={onWatch}>
              <Play className="fill-current" />
              {t("Watch")}
            </Button>
          ),
        });

  return (
    <div className="pointer-events-none relative flex max-w-[34rem] flex-col items-center px-12 text-center">
      <ChannelLogo channel={channel} className="mb-6 h-14 w-20" />
      <h2 className="text-3xl font-semibold tracking-tight text-balance">{message.title}</h2>
      {message.body && (
        <p className="mt-3 text-[0.9375rem] leading-relaxed text-muted-foreground">
          {message.body}
        </p>
      )}
      {message.evidence && <Evidence>{message.evidence}</Evidence>}
      {fallback && <Evidence>{fallback}</Evidence>}
      {message.actions && (
        <div className="pointer-events-auto mt-7 flex items-center gap-3">{message.actions}</div>
      )}
      {message.failure && <CloseMessage failure={message.failure} />}
    </div>
  );
}

/** A run of fallback channels: the channel the viewer chose, the one playing in its place, and those tried. */
interface FallingBack {
  readonly chosen: LiveChannel;
  readonly playing: LiveChannel;
  readonly tried: readonly OwnedId[];
}

/**
 * Plays the next fallback channel when the one playing fails, as the channel the viewer chose
 * names them now. Answers what the picture area says of the run: which fallback plays instead and
 * from where while it tunes or fails, or that none played; null outside a run. A fallback that
 * can't be read now isn't played: the failure stays, with what it offers.
 */
function useFallback(channel: LiveChannel): string | null {
  const client = useQueryClient();
  const output = useOutput((state) => state.status.output);
  const phase = usePlayer((state) => state.phase);
  const nameOf = useSubscriptionNames();
  const [run, setRun] = useState<FallingBack | null>(null);
  const current = run && sameOwned(run.playing, channel) ? run : null;

  useEffect(() => {
    if (run && !current) setRun(null);
  }, [run, current]);

  useEffect(() => {
    if (phase.kind !== "failed" || output.kind !== "local") return;
    const error = problemError(phase.problem);

    if (!error) return;

    const chosen =
      current?.chosen ?? client.getQueryData(queries.channel(channel).queryKey) ?? channel;

    const tried = [...(current?.tried ?? []), ownedId(channel)];

    // No named alternative means no fallback run, including for kids and refused streams.
    if (!current && !fallbackAfter(chosen, error, tried)) return;

    let mine = true;

    void (async () => {
      let latest: LiveChannel;

      try {
        latest = await client.fetchQuery(queries.channel(chosen));
      } catch (cause) {
        if (appError(cause).kind !== "channel-not-found") throw cause;
        const saved = await client.fetchQuery(chosenChannelsQuery());
        const choices = saved.find((entry) => sameOwned(entry.choices.channel, chosen))?.choices;
        latest = { ...chosen, choices: choices ?? {} };
      }

      let next = fallbackAfter(latest, error, tried);
      let found: LiveChannel | null = null;

      while (next && mine && outputs.status().output.kind === "local") {
        try {
          found = await client.fetchQuery(queries.channel(next));
          break;
        } catch (cause) {
          if (appError(cause).kind !== "channel-not-found") throw cause;
          tried.push(next);
          next = fallbackAfter(latest, error, tried);
        }
      }

      if (!mine || outputs.status().output.kind !== "local" || player.state().phase !== phase)
        return;

      if (!found) {
        setRun({ chosen: latest, playing: channel, tried });

        return;
      }

      setRun({ chosen: latest, playing: found, tried: [...tried, ownedId(found)] });
      flashNote(
        t("{channel} didn't play. {fallback} from {subscription} plays instead.", {
          channel: latest.title,
          fallback: found.title,
          subscription: nameOf(found.subscriptionId) ?? "",
        }),
      );
      player.play(found);
    })().catch(() => {
      if (mine) flashNote(t("Couldn't read your changed channels."), true);
    });

    return () => {
      mine = false;
    };
    // Once per failure: the phase of each is its own.
  }, [phase, output.kind]);

  if (output.kind !== "local") return null;

  if (!current || phase.kind === "playing") return null;

  if (phase.kind === "failed") {
    const error = problemError(phase.problem);

    // Until the next one starts, the failure stands as it is.
    return error && fallbackAfter(current.chosen, error, current.tried)
      ? null
      : t("{channel} and its fallback channels didn't play.", { channel: current.chosen.title });
  }

  return t("{channel} didn't play. Its fallback from {subscription} plays instead.", {
    channel: current.chosen.title,
    subscription: nameOf(current.playing.subscriptionId) ?? "",
  });
}

/**
 * A failure as `fallbackAfter` reads it; null for a receiver's, which another channel can't help.
 * The status is all the player keeps of a stream the provider didn't deliver.
 */
function problemError(problem: PlaybackProblem): AppError | null {
  switch (problem.kind) {
    case "app":
      return problem.error;
    case "receiver":
      return null;
    case "network":
    case "unsupported":
      return { kind: "stream", failure: { kind: problem.kind, detail: "" } };
    default:
      return { kind: "stream", failure: problem };
  }
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
  const source = useFailedSource(channel);
  const connecting = useOutput((state) => state.status.output.kind === "connecting");

  if (problem.kind === "receiver") {
    return (
      canRetry(problem) &&
      !connecting && (
        <Button variant="primary" onClick={retryFailed}>
          <RotateCw />
          {t("Try again")}
        </Button>
      )
    );
  }

  // Its subscription's row in Settings is where a login is corrected, or entered again: the
  // other subscriptions' channels stay in the lists meanwhile.
  if (problem.kind === "app" && problem.error.kind === "invalid-login") {
    return (
      <>
        <Button variant="primary" onClick={() => openSubscription(channel.subscriptionId, "edit")}>
          {t("Update login")}
        </Button>
        {channels}
      </>
    );
  }

  if (problem.kind === "app" && problem.error.kind === "needs-secret") {
    return (
      <>
        <Button
          variant="primary"
          onClick={() => openSubscription(channel.subscriptionId, "secret")}
        >
          {source?.playlist ? t("Enter link") : t("Enter password")}
        </Button>
        {channels}
      </>
    );
  }

  const retry = canRetry(problem) && (
    <Button variant="primary" onClick={retryFailed}>
      <RotateCw />
      {t("Retry")}
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
          {t("Automatic")}
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
          {t("Quality")}
        </Button>
      ) : (
        <Button variant="secondary" onClick={onNext}>
          <SkipForward />
          {t("Next channel")}
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
      {phase.until === null ? (
        t("attempt {attempt} of {of}", { attempt: phase.attempt, of: phase.of })
      ) : (
        <Remaining attempt={phase.attempt} of={phase.of} until={phase.until} />
      )}
    </>
  );
}

/** "attempt 2 of 4 in 4 s", counted down once a second until `until`. */
function Remaining({ attempt, of, until }: { attempt: number; of: number; until: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(timer);
  }, [until]);

  return t("attempt {attempt} of {of} in {seconds} s", {
    attempt,
    of,
    seconds: Math.max(1, Math.ceil((until - now) / 1000)),
  });
}

/** "Tuning · 3 s", updated once a second. */
function Elapsed({ since, what = t("Tuning") }: { since: number; what?: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(timer);
  }, []);

  return (
    <>
      {what} · {t("{seconds} s", { seconds: Math.max(0, Math.floor((now - since) / 1000)) })}
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
  failure,
  actions,
}: {
  line?: ReactNode;
  title?: string;
  body?: ReactNode;
  evidence?: ReactNode;
  failure?: FailedPhase | undefined;
  actions: ReactNode;
}) {
  return (
    <div className="pointer-events-none relative flex max-w-[34rem] flex-col items-center px-12 text-center">
      {line}
      {title && <h2 className="text-3xl font-semibold tracking-tight text-balance">{title}</h2>}
      {body && (
        <p className="mt-3 text-[0.9375rem] leading-relaxed text-muted-foreground">{body}</p>
      )}
      {evidence && <Evidence>{evidence}</Evidence>}
      <div className="pointer-events-auto mt-5 flex items-center gap-3">{actions}</div>
      {failure && <CloseMessage failure={failure} />}
    </div>
  );
}
