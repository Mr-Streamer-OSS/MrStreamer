// Which of a channel's streams Watch has chosen, would play on Automatic, and plays, and what the
// channel's last try says of each.
import { useQuery } from "@tanstack/react-query";
import type { ChannelVariant, LiveChannel } from "@mrstreamer/contracts/library";
import { chosenVariant, streamsToPlay } from "@mrstreamer/core/catalogue/variants";
import { queries } from "../../lib/queries.ts";
import { usePlayer } from "../../player/player.ts";
import { streamNote } from "./problems.ts";

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
  /**
   * What the channel's last try says of its streams, by stream id, for the quality menu's rows:
   * why the provider didn't deliver one, which one plays, and once the channel failed, which one
   * arrived without playing and which were never reached. Nothing from before that try, and
   * nothing while no try has said.
   */
  readonly notes: ReadonlyMap<string, string>;
}

export function useChannelQuality(channel: LiveChannel): ChannelQuality {
  const preferences = useQuery(queries.preferences()).data;
  const stream = usePlayer((state) => (state.channel?.id === channel.id ? state.stream : null));
  const fellBack = usePlayer((state) => (state.channel?.id === channel.id ? state.fellBack : null));
  const phase = usePlayer((state) => (state.channel?.id === channel.id ? state.phase : null));
  const variant = (id: string | null | undefined) =>
    channel.variants.find((each) => each.id === id);
  const chosen = chosenVariant(channel, preferences?.channelVariants);
  // Automatic's order, whatever was chosen.
  const automatic = streamsToPlay(channel, { ...preferences, channelVariants: {} });
  const playing = variant(stream?.variantId);
  const from = variant(fellBack?.from);
  const to = variant(fellBack?.to);
  const notes = new Map<string, string>();
  const note = (id: string, said: string | null) => {
    if (said && variant(id)) notes.set(id, said);
  };
  if (stream) {
    for (const { variantId, failure } of stream.failed) note(variantId, streamNote(failure));
    if (stream.variantId && phase?.kind === "playing") note(stream.variantId, "Playing");
    // Only a failure that is a stream's says anything of the streams it didn't get to.
    const failure = phase?.kind === "failed" ? streamNote(phase.problem) : null;
    if (failure) {
      if (stream.variantId) note(stream.variantId, failure);
      for (const { id } of channel.variants) if (!notes.has(id)) notes.set(id, "Not tried");
    }
  }
  return {
    chosen,
    automatic: (!chosen && playing) || automatic[0],
    playing,
    fellBack: from && to ? { from, to } : null,
    alternative: automatic.find((each) => each.id !== chosen?.id),
    notes,
  };
}
