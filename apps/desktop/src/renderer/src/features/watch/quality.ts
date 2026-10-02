// Which of a channel's streams Watch has chosen, would play on Automatic, and plays.
import { useQuery } from "@tanstack/react-query";
import type { ChannelVariant, LiveChannel } from "@mrstreamer/contracts/library";
import { chosenVariant, streamsToPlay } from "@mrstreamer/core/catalogue/variants";
import { queries } from "../../lib/queries.ts";
import { usePlayer } from "../../player/player.ts";

export interface ChannelQuality {
  /** The stream chosen for the channel, or null for Automatic. */
  readonly chosen: ChannelVariant | null;
  /** What Automatic plays, or would start with. */
  readonly automatic: ChannelVariant | undefined;
  /** The stream playing, once one is. */
  readonly playing: ChannelVariant | undefined;
  /** Automatic played `to` because `from` didn't start. */
  readonly fellBack: { readonly from: ChannelVariant; readonly to: ChannelVariant } | null;
  /** The stream Automatic would try first besides the chosen one, to offer when it fails. */
  readonly alternative: ChannelVariant | undefined;
}

export function useChannelQuality(channel: LiveChannel): ChannelQuality {
  const preferences = useQuery(queries.preferences()).data;
  const stream = usePlayer((state) => (state.channel?.id === channel.id ? state.stream : null));
  const fellBack = usePlayer((state) => (state.channel?.id === channel.id ? state.fellBack : null));
  const variant = (id: string | null | undefined) =>
    channel.variants.find((each) => each.id === id);
  const chosen = chosenVariant(channel, preferences?.channelVariants);
  // Automatic's order, whatever was chosen.
  const automatic = streamsToPlay(channel, { ...preferences, channelVariants: {} });
  const playing = variant(stream?.variantId);
  const from = variant(fellBack?.from);
  const to = variant(fellBack?.to);
  return {
    chosen,
    automatic: (!chosen && playing) || automatic[0],
    playing,
    fellBack: from && to ? { from, to } : null,
    alternative: automatic.find((each) => each.id !== chosen?.id),
  };
}
