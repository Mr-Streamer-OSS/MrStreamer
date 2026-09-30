// What the picture area says when there is no picture: idle, tuning, reconnecting or failed.
import { Play, RotateCw, SkipForward } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { LiveChannel } from "../../../../shared/library.ts";
import { useUi } from "../../app/ui-store.ts";
import { ChannelLogo } from "../../components/ChannelLogo.tsx";
import { Button } from "../../components/ui/button.tsx";
import { describeError } from "../../lib/errors.ts";
import { player, usePlayer, type PlaybackProblem } from "../../player/player.ts";

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
  } else {
    message = problemMessage(phase.problem, channel, onNext);
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

function problemMessage(
  problem: PlaybackProblem,
  channel: LiveChannel,
  onNext: () => void,
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
        body: "The provider refused this stream. Another device may be using your connection.",
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
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>Tuning · {Math.max(0, Math.floor((now - since) / 1000))} s</>;
}
