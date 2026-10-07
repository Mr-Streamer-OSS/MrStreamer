// Display-only channel search groups. Copies remain canonical channels with their own playback,
// guide, numbers and favourites. This never changes the catalogue's channel or variant grouping.
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { ownedKey } from "@mrstreamer/contracts/subscription";

export interface LiveSearchGroup {
  readonly key: string;
  readonly copies: readonly LiveChannel[];
  /** Distinct playable subscription/stream pairs, including backups of the same quality. */
  readonly streams: number;
}

export interface LiveSearchIndex {
  readonly groups: readonly LiveSearchGroup[];
  readonly byCopy: ReadonlyMap<string, LiveSearchGroup>;
}

/** Build once per loaded catalogue/list, so a programme-only match can retain all real copies. */
export function indexLiveSearch(channels: readonly LiveChannel[]): LiveSearchIndex {
  const groups = groupLiveSearch(channels);
  return {
    groups,
    byCopy: new Map(
      groups.flatMap((group) => group.copies.map((copy) => [ownedKey(copy), group] as const)),
    ),
  };
}

/** Matching groups in the matches' order, including their nonmatching canonical copies. */
export function matchingSearchGroups(
  index: LiveSearchIndex,
  matches: readonly LiveChannel[],
): readonly LiveSearchGroup[] {
  const groups = new Set<LiveSearchGroup>();
  for (const copy of matches) {
    const group = index.byCopy.get(ownedKey(copy));
    if (group) groups.add(group);
  }
  return [...groups];
}

/**
 * Fold channels using catalogue-validated identities. Region/topic buckets
 * keep work linear in copies and their topics. A copy without a guide never bridges conflicting
 * guide identities. Missing regions or topics need a trusted guide, even within one provider.
 */
export function groupLiveSearch(channels: readonly LiveChannel[]): readonly LiveSearchGroup[] {
  const guides = new Map<string, LiveChannel[]>();
  const ordinary = new Map<string, LiveChannel[]>();
  const alone: LiveChannel[][] = [];
  const seen = new Set<string>();
  const order = new Map<LiveChannel, number>();
  const topicGroups = new Map<string, Set<LiveChannel[]>>();
  const commonTopics = new Map<LiveChannel[], Set<string>>();
  const guidedCandidates = new Map<string, LiveChannel[]>();
  const regionKeys = (channel: LiveChannel): string[] => {
    const identity = channel.searchIdentity;
    return identity?.region
      ? [...new Set(identity.topics)].map((topic) =>
          JSON.stringify([identity.title, identity.language, identity.region, topic]),
        )
      : [];
  };
  for (const channel of channels) {
    if (seen.has(ownedKey(channel))) continue;
    seen.add(ownedKey(channel));
    order.set(channel, order.size);
    const identity = channel.searchIdentity;
    if (!identity || !identity.title) {
      alone.push([channel]);
      continue;
    }
    const regional = regionKeys(channel);
    if (identity.guideId) {
      const key = JSON.stringify([identity.title, identity.language, identity.guideId]);
      const copies = guidedCandidates.get(key);
      if (copies) copies.push(channel);
      else guidedCandidates.set(key, [channel]);
    } else if (regional.length > 0) {
      const key = JSON.stringify(regional.sort());
      const copies = ordinary.get(key);
      if (copies) copies.push(channel);
      else ordinary.set(key, [channel]);
    } else alone.push([channel]);
  }
  for (const [guideKey, candidates] of guidedCandidates) {
    const regions = new Set(candidates.flatMap((copy) => copy.searchIdentity?.region ?? []));
    for (const copy of candidates) {
      // A shared validated guide can supply missing region, but cannot erase known conflicts.
      const key =
        regions.size <= 1
          ? guideKey
          : JSON.stringify([guideKey, copy.searchIdentity?.region ?? ownedKey(copy)]);
      const copies = guides.get(key);
      if (copies) copies.push(copy);
      else guides.set(key, [copy]);
    }
  }
  const register = (keys: Iterable<string>, copies: LiveChannel[]) => {
    for (const key of keys) {
      const groups = topicGroups.get(key) ?? new Set<LiveChannel[]>();
      groups.add(copies);
      topicGroups.set(key, groups);
    }
  };
  for (const copies of guides.values()) {
    register(copies.flatMap(regionKeys), copies);
  }
  for (const copies of ordinary.values()) {
    const keys = new Set(regionKeys(copies[0]!));
    const candidates = new Set<LiveChannel[]>();
    let ambiguous = false;
    for (const key of keys) {
      const groups = topicGroups.get(key);
      // Several trusted guide identities cannot be bridged by an unlabelled copy. Stop at the
      // first ambiguity, so even a widely reused topic never causes pairwise comparisons.
      if (groups && groups.size > 1) {
        ambiguous = true;
        break;
      }
      const group = groups?.values().next().value;
      if (group) candidates.add(group);
      if (candidates.size > 1) {
        ambiguous = true;
        break;
      }
    }
    const destination = !ambiguous ? candidates.values().next().value : undefined;
    if (destination) {
      destination.push(...copies);
      const common = commonTopics.get(destination);
      if (common)
        for (const key of common)
          if (!keys.has(key)) {
            common.delete(key);
            topicGroups.get(key)?.delete(destination);
          }
    } else {
      alone.push(copies);
      if (!ambiguous) {
        commonTopics.set(copies, keys);
        register(keys, copies);
      }
    }
  }
  return [...guides.values(), ...alone]
    .map((copies): LiveSearchGroup => {
      copies.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
      const streams = new Set(
        copies.flatMap((channel) =>
          channel.variants.map((variant) => JSON.stringify([channel.subscriptionId, variant.id])),
        ),
      );
      return { key: ownedKey(copies[0]!), copies, streams: streams.size };
    })
    .sort((a, b) => (order.get(a.copies[0]!) ?? 0) - (order.get(b.copies[0]!) ?? 0));
}

/** Reconstruct search responses without regrouping a subset of the catalogue. */
export function searchResultGroups(channels: readonly LiveChannel[]): readonly LiveSearchGroup[] {
  const groups = new Map<string, LiveChannel[]>();
  const seen = new Set<string>();
  for (const channel of channels) {
    const id = ownedKey(channel);
    if (seen.has(id)) continue;
    seen.add(id);
    const key = channel.searchGroup ?? id;
    const copies = groups.get(key);
    if (copies) copies.push(channel);
    else groups.set(key, [channel]);
  }
  return [...groups].map(([key, copies]) => ({
    key,
    copies,
    streams: new Set(
      copies.flatMap((channel) =>
        channel.variants.map((variant) => JSON.stringify([channel.subscriptionId, variant.id])),
      ),
    ).size,
  }));
}

/** Favourite copies first, then saved subscription order. Never synthesizes a playback owner. */
export function automaticSearchCopy(
  group: LiveSearchGroup,
  favourites: ReadonlySet<string>,
  subscriptions: readonly { readonly id: string }[],
): LiveChannel {
  const positions = new Map(subscriptions.map(({ id }, index) => [id, index]));
  return group.copies.reduce((chosen, copy) => {
    const starred = favourites.has(ownedKey(copy));
    const chosenStarred = favourites.has(ownedKey(chosen));
    if (starred !== chosenStarred) return starred ? copy : chosen;
    return (positions.get(copy.subscriptionId) ?? Infinity) <
      (positions.get(chosen.subscriptionId) ?? Infinity)
      ? copy
      : chosen;
  });
}
