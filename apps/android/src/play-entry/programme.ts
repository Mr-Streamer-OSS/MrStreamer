import type { Programme } from "@mrstreamer/contracts/guide";
import type { ProviderChannel } from "@mrstreamer/core/provider";
import { archiveHolds } from "@mrstreamer/core/catchup";
import type { PlayIntent } from "../player/intent.ts";
import type { ChannelIdentity } from "../guide/routes.ts";

/** Exact provider channel only. Guide browsing supplies identity and times, never an address. */
export function programmeEntry(
  identity: ChannelIdentity,
  channel: Pick<ProviderChannel, "id" | "catchupDays">,
  channelName: string,
  programme: Programme,
  now: number,
) {
  if (channel.id !== identity.channelId) return null;
  const live: PlayIntent = { kind: "live", ...identity, title: channelName };
  const days = channel.catchupDays;

  const reason =
    programme.start >= programme.stop
      ? "invalid"
      : programme.start >= now
        ? "future"
        : !days
          ? "none"
          : !archiveHolds(days, programme.start, now)
            ? "outside"
            : null;

  const archive: PlayIntent | null =
    reason === null && days
      ? {
          kind: "catch-up",
          ...identity,
          title: programme.title,
          window: { start: programme.start, end: programme.stop },
          days,
        }
      : null;

  return { live, archive, reason };
}
