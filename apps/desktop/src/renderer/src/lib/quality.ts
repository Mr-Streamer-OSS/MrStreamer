// How live channels' qualities read: the provider's word, never a guess. A stream whose name gives
// no quality is "Not labelled"; the resolution the decoder reports stands beside it.
import {
  QUALITIES,
  type ChannelVariant,
  type LiveChannel,
  type Quality,
} from "@mrstreamer/contracts/library";
import { t } from "@mrstreamer/core/i18n";

const NAMES: Readonly<Record<Quality, string>> = {
  uhd: "4K",
  fhd: "Full HD",
  hd: "HD",
  sd: "SD",
};

const SHORT: Readonly<Record<Quality, string>> = { uhd: "4K", fhd: "FHD", hd: "HD", sd: "SD" };

/** "Full HD", or "Not labelled" when the provider doesn't say. */
export function qualityName(variant: ChannelVariant | undefined): string {
  return variant?.quality ? NAMES[variant.quality] : t("Not labelled");
}

/** The name of a quality to choose in Settings: "Full HD". */
export function preferenceName(quality: Quality): string {
  return NAMES[quality];
}

/** "FHD": what the quality button says. Null when the provider doesn't say. */
export function shortQuality(variant: ChannelVariant | undefined): string | null {
  return variant?.quality ? SHORT[variant.quality] : null;
}

/** "4K · FHD · HD" for a channel with several streams, best first; empty for one with one. */
export function qualitiesLine(channel: LiveChannel): string {
  if (channel.variants.length < 2) return "";
  const known = new Set(channel.variants.flatMap(({ quality }) => quality ?? []));
  return QUALITIES.filter((quality) => known.has(quality))
    .map((quality) => SHORT[quality])
    .join(" · ");
}

/**
 * A channel's streams as the quality menu lists them, best first and those not labelled last, each
 * with its name. Two that read the same are numbered: "Full HD", "Full HD 2".
 */
export function qualityChoices(
  channel: LiveChannel,
): { readonly variant: ChannelVariant; readonly name: string }[] {
  const rank = ({ quality }: ChannelVariant) =>
    quality ? QUALITIES.indexOf(quality) : QUALITIES.length;
  const seen = new Map<string, number>();
  return channel.variants
    .toSorted((a, b) => rank(a) - rank(b))
    .map((variant) => {
      const name = qualityName(variant);
      const count = (seen.get(name) ?? 0) + 1;
      seen.set(name, count);
      return { variant, name: count > 1 ? `${name} ${count}` : name };
    });
}
