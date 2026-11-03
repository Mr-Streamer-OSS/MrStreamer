import type { LiveCatalogue } from "@mrstreamer/core/provider";
import { normalizeSteps } from "@mrstreamer/core/catalogue/normalize";
import { liveChannelSteps } from "@mrstreamer/core/catalogue/variants";
import { isAdultCategory } from "@mrstreamer/core/adult";
import type { Steps } from "@mrstreamer/core/steps";

export interface GuideChannel {
  readonly id: string;
  readonly key: string;
  readonly title: string;
}

export interface Part {
  readonly subscriptionId: string;
  readonly guideIds: ReadonlyMap<string, readonly string[]>;
  readonly byId: ReadonlyMap<string, GuideChannel>;
}

/** Canonical channels and trusted ids use the same normalization as the mobile catalogue. */
export function* partSteps(subscriptionId: string, catalogue: LiveCatalogue): Steps<Part> {
  const adultCategories = new Set(
    catalogue.categories.filter((c) => isAdultCategory(c.name)).map((c) => c.id),
  );

  const adult = new Set(
    catalogue.channels
      .filter((c) => c.adult || c.categoryIds.some((id) => adultCategories.has(id)))
      .map((c) => c.id),
  );

  const { streams } = yield* normalizeSteps(catalogue);
  const normalized = yield* liveChannelSteps(streams);
  const byId = new Map<string, GuideChannel>();
  const guideIds = new Map<string, readonly string[]>();

  for (const channel of normalized.channels) {
    if (channel.variants.some((v) => adult.has(v.id))) continue;
    const row = { id: channel.id, key: `${subscriptionId}:${channel.id}`, title: channel.title };
    byId.set(channel.id, row);

    for (const variant of channel.variants) byId.set(variant.id, row);
    guideIds.set(channel.id, normalized.guideIds.get(channel.id) ?? []);
  }

  return { subscriptionId, byId, guideIds };
}
