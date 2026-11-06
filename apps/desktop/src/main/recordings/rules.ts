import type { ProgrammeMatch } from "@mrstreamer/contracts/guide";
import {
  RECORDING_MAX_MS,
  RECORDING_RULE_LIMITS,
  type RecordingRulePlan,
  type RecordingRulePreview,
} from "@mrstreamer/contracts/recordings";
import { ownedId, ownedKey } from "@mrstreamer/contracts/subscription";

/** Preview and execution share matching, provenance, padding and work limits. */
export function planRule(
  plan: RecordingRulePlan,
  matches: readonly ProgrammeMatch[],
  now: number,
  limited = false,
): RecordingRulePreview {
  const channels = new Set(plan.channels.map(ownedKey));
  const found: RecordingRulePreview["matches"][number][] = [];
  let unproven = 0;

  for (const { channel, programme } of matches) {
    if (
      !channels.has(ownedKey(channel)) ||
      programme.title.trim().toLocaleLowerCase() !== plan.title.trim().toLocaleLowerCase() ||
      programme.stop <= now
    )
      continue;
    const metadata = programme.metadata;
    const episode = metadata?.episode;
    // xmltv_ns is structured episode identity; arbitrary provider episode strings need a
    // documented system before they can promise identity. Premiere is positive evidence.
    const reliable = metadata?.guide && episode;

    if (plan.mode === "new-only" && (!reliable || metadata.repeat || !metadata.premiere?.trim())) {
      unproven++;
      continue;
    }

    const episodeIdentity = reliable
      ? JSON.stringify([
          ownedKey(channel),
          metadata.guide,
          programme.title,
          episode.season,
          episode.episode,
          episode.part ?? null,
        ])
      : undefined;

    const identity =
      plan.mode === "new-only" && episodeIdentity
        ? episodeIdentity
        : JSON.stringify([ownedKey(channel), metadata?.guide ?? null, programme.start]);

    const duration =
      programme.stop - programme.start + (plan.padding.before + plan.padding.after) * 60_000;

    if (
      duration <= 0 ||
      duration > RECORDING_MAX_MS ||
      found.some((each) => each.identity === identity)
    )
      continue;

    if (found.length === RECORDING_RULE_LIMITS.matches) {
      limited = true;
      break;
    }

    found.push({
      identity,
      ...(episodeIdentity && { episodeIdentity }),
      channelName: channel.title,
      plan: {
        kind: "programme",
        channel: ownedId(channel),
        start: programme.start,
        stop: programme.stop,
        title: programme.title,
        padding: plan.padding,
      },
    });
  }

  return { matches: found, limited, unproven };
}
