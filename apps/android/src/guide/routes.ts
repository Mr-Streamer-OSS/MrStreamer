import { defined } from "@mrstreamer/core/defined";
import type { DestinationRoute } from "../navigation/destinations.ts";

const on = (destination: DestinationRoute, route: string) =>
  destination === "(live)" ? `/guide/${route}` : `/${destination}/guide/${route}`;

const params = (values: Record<string, string>) => new URLSearchParams(values).toString();

/** guidesHref(destination): Guides on the current stack; Back returns to its caller. */
export const guidesHref = (destination: DestinationRoute) => on(destination, "guides");
export const mapHref = (destination: DestinationRoute) => on(destination, "map");

/** Channel identity is the stable source id plus the provider's channel id, never its name. */
export interface ChannelIdentity {
  readonly sourceId: string;
  readonly channelId: string;
}

export const channelMapHref = (destination: DestinationRoute, channel: ChannelIdentity) =>
  `${on(destination, "channel-map")}?${params({ source: channel.sourceId, channel: channel.channelId })}`;

/** scheduleHref(destination, {sourceId, channelId}, day?): one local day on the caller's stack.
 * Back returns to where Schedule opened. day is a local midnight epoch, not a UTC date. */
export const scheduleHref = (
  destination: DestinationRoute,
  channel: ChannelIdentity,
  day?: number,
) =>
  `${on(destination, "schedule")}?${params({ source: channel.sourceId, channel: channel.channelId, ...defined({ day: day === undefined ? undefined : String(day) }) })}`;

/** programmeHref(destination, channel, start, detail?): stable programme identity is channel +
 * start epoch. The optional detail is a revocable service token, never the identity. Opens on
 * the current destination's stack, so Back returns to Schedule or wherever it opened from. */
export const programmeHref = (
  destination: DestinationRoute,
  channel: ChannelIdentity,
  start: number,
  detail?: string,
) =>
  `${on(destination, "programme")}?${params({ source: channel.sourceId, channel: channel.channelId, start: String(start), ...defined({ detail }) })}`;
