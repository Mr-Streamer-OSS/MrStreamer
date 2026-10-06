// What a channel that doesn't play says, wherever it says it: the middle of Watch, the mini player,
// the bar at the foot of the pages and the rows of the quality menu. Every word comes from what was
// observed: the kind of failure, the provider's HTTP status, the streams tried, and whether the
// channel never started, broke off, or kept coming back and breaking off. A status names no cause,
// so a refusal is never called a connection limit or a wrong login, and nothing an engine or the
// provider said in words is shown: those can name an address.
import type { AppError } from "@mrstreamer/contracts/errors";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { LivePlaying, StreamFailure } from "@mrstreamer/contracts/playback";
import { describeError } from "../../lib/errors.ts";
import { clockTime } from "../../lib/format.ts";
import { qualityChoices } from "../../lib/quality.ts";
import { outputs } from "../../player/output.ts";
import { STABLE_PLAYBACK_MS, type PlaybackProblem, type PlayerState } from "../../player/player.ts";
import { receiverProblem } from "./Output.tsx";

export type FailedPhase = Extract<PlayerState["phase"], { kind: "failed" }>;
export type ReconnectingPhase = Extract<PlayerState["phase"], { kind: "reconnecting" }>;

/** Which of a channel's streams its last try got to, by the names the quality menu gives them. */
export interface Tried {
  /** In the order tried. */
  readonly names: readonly string[];
  /** How many of the channel's streams it never reached. */
  readonly untried: number;
}

/** The streams `stream` says were tried; null when nothing says, as for a channel a receiver plays. */
export function triedStreams(channel: LiveChannel, stream: LivePlaying | null): Tried | null {
  if (!stream) return null;
  const ids = new Set(stream.failed.map(({ variantId }) => variantId));
  if (stream.variantId) ids.add(stream.variantId);
  const choices = qualityChoices(channel);
  const names = [...ids].flatMap(
    (id) => choices.find(({ variant }) => variant.id === id)?.name ?? [],
  );
  return { names, untried: channel.variants.length - names.length };
}

/**
 * Whether a failure is the stream's own, so another of the channel's streams may play where this
 * one didn't. A refusal isn't counted as one. Its status names no cause, so nothing shows another
 * stream would be let through, and the app stops instead of sending more requests against it. A
 * session that didn't open or a receiver's trouble is no stream's.
 */
export function isStreamsOwn(problem: PlaybackProblem): boolean {
  return problem.kind !== "refused" && problem.kind !== "app" && problem.kind !== "receiver";
}

/** Whether trying the same channel again can help. An unplayable stream stays unplayable. */
export function canRetry(problem: PlaybackProblem): boolean {
  if (problem.kind === "receiver") {
    return receiverProblem(problem.failure, problem.lost, outputs.failedOn(), null).retry;
  }
  if (problem.kind === "app") return problem.error.kind !== "invalid-login";
  return problem.kind !== "unsupported";
}

/**
 * A failed channel's title and the sentence under it. `chosen` names the quality picked for the
 * channel when the failure is that stream's own: the pick stays, and the words say so. `playlist`
 * is a playlist subscription, which has no connection of its own for another device to hold.
 */
export function failureCopy(
  { problem, recovery }: FailedPhase,
  channel: LiveChannel,
  context: {
    readonly chosen: string | null;
    readonly playlist: boolean;
    readonly tried: Tried | null;
  },
): { readonly title: string; readonly body: string } {
  const { chosen, playlist, tried } = context;
  const name = channel.title;
  const stays = chosen ? ` Your choice stays ${chosen}.` : "";
  const its = chosen ? `${name}'s ${chosen} stream` : `${name}'s stream`;
  switch (problem.kind) {
    case "unavailable":
      if (chosen) {
        return {
          title: `No ${chosen} stream`,
          body: `The provider sent no ${chosen} stream for ${name}.${stays}`,
        };
      }
      return {
        title: "No stream right now",
        body:
          tried && tried.names.length > 1 && tried.untried === 0
            ? `The provider lists ${name} but sent no stream for any of its qualities.`
            : `The provider lists ${name} but sent no stream for it.`,
      };
    case "refused":
      if (problem.status === 429) {
        return {
          title: "Provider is limiting requests",
          body: "The provider answered that it gets too many requests. Wait a moment before trying again.",
        };
      }
      return {
        title: "Refused by the provider",
        body: `${name}'s stream was turned down.${refusalCheck(problem.status, playlist)}`,
      };
    case "provider-error":
      return {
        title: "Provider error",
        body: `The provider answered with an error instead of the stream.${stays}`,
      };
    case "unsupported":
      return {
        title: chosen ? `Can't play ${chosen}` : "Can't play this stream",
        body: `${its} arrived, but Mr. Streamer couldn't play it on this computer.${stays}`,
      };
    case "network":
      if (!recovery.played) {
        return problem.unanswered
          ? {
              title: "No answer from the provider",
              body: `${its} never started sending.${stays}`,
            }
          : { title: "No picture arrived", body: `${its} sent no picture or sound.${stays}` };
      }
      if (recovery.relapses > 0) {
        const other = !chosen && channel.variants.length > 1;
        return {
          title: "Keeps dropping",
          body: `${name} came back ${times(recovery.relapses)} and dropped again within ${STABLE_PLAYBACK_MS / 1000} seconds.${other ? " Another quality may hold better." : stays}`,
        };
      }
      return {
        title: "Lost the stream",
        body:
          recovery.reconnects > 0
            ? `${name} stopped arriving and reconnecting didn't bring it back.${stays}`
            : `${name} stopped arriving.${stays}`,
      };
    case "app":
      return problem.error.kind === "invalid-login"
        ? { title: "Login not accepted", body: describeError(problem.error) }
        : { title: "Can't open this channel", body: describeOpening(problem.error) };
    case "receiver":
      return receiverProblem(problem.failure, problem.lost, outputs.failedOn(), null);
  }
}

/**
 * What a refusal is worth checking, said as a condition and never as its cause. Only 401 and 403
 * get one: what a panel means by 458 or 509 isn't known.
 */
function refusalCheck(status: number, playlist: boolean): string {
  if (status !== 401 && status !== 403) return "";
  return playlist
    ? " Some playlist channels only play in certain countries."
    : " If another device is watching on this subscription, stop it there first.";
}

const QUOTES_NOTHING = new Set<AppError["kind"]>([
  "account-inactive",
  "provider-error",
  "no-subscription",
  "keychain-refused",
  "channel-not-found",
]);

/** Why a channel's session didn't open, without what an error quotes: a server's name or an engine's words. */
function describeOpening(error: AppError): string {
  if (QUOTES_NOTHING.has(error.kind)) return describeError(error);
  return error.kind === "unreachable"
    ? "The provider can't be reached."
    : "Mr. Streamer couldn't open it.";
}

/** "once", "twice", "3 times". */
function times(count: number): string {
  return count === 1 ? "once" : count === 2 ? "twice" : `${count} times`;
}

/** "1 reconnect", "4 reconnects". */
function counted(count: number, what: string): string {
  return `${count} ${what}${count === 1 ? "" : "s"}`;
}

/**
 * What was observed of a failure, in one short line: the provider's status, the qualities tried,
 * the reconnects made and when it failed. Empty where the failure isn't a stream's.
 */
export function failureEvidence(
  { problem, recovery, at }: FailedPhase,
  channel: LiveChannel,
  context: { readonly chosen: string | null; readonly tried: Tried | null },
): string {
  if (problem.kind === "app" || problem.kind === "receiver") return "";
  const { chosen, tried } = context;
  return [
    "status" in problem ? `HTTP ${problem.status}` : null,
    chosen
      ? `${chosen} only, as chosen`
      : channel.variants.length > 1 && tried
        ? tried.names.join(", ")
        : null,
    recovery.reconnects > 0 ? counted(recovery.reconnects, "reconnect") : null,
    clockTime(at, at),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A failed channel in a few words, as the mini player says it. */
export function failureTitle(failed: FailedPhase, channel: LiveChannel): string {
  return failureCopy(failed, channel, { chosen: null, playlist: false, tried: null }).title;
}

/**
 * A failed channel in one line, as the bar at the foot of the pages says it: its title, and the
 * provider's status when it gave one.
 */
export function failureLine(failed: FailedPhase, channel: LiveChannel): string {
  const title = failureTitle(failed, channel);
  return "status" in failed.problem ? `${title} · HTTP ${failed.problem.status}` : title;
}

/** A channel that reconnects, in a title and a sentence. Which attempt it is at stands beside them. */
export function reconnectingCopy(channel: LiveChannel): {
  readonly title: string;
  readonly body: string;
} {
  return { title: "Reconnecting", body: `${channel.title}'s stream isn't arriving.` };
}

/** "Reconnecting · 2 of 4", as the mini player says it. */
export function reconnectingLine({ attempt, of }: ReconnectingPhase): string {
  return `Reconnecting · ${attempt} of ${of}`;
}

/**
 * What became of one of a channel's streams, as its row of the quality menu says it: "No stream ·
 * 404". Null for what says nothing of a stream.
 */
export function streamNote(result: StreamFailure | PlaybackProblem): string | null {
  switch (result.kind) {
    case "unavailable":
      return `No stream · ${result.status}`;
    case "refused":
      return `Refused · ${result.status}`;
    case "provider-error":
      return `Error · ${result.status}`;
    case "network":
      return "unanswered" in result && !result.unanswered ? "No picture" : "No data";
    case "unsupported":
      return "Can't play";
    case "app":
    case "receiver":
      return null;
  }
}
