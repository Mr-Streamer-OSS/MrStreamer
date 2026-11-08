import type { TitleFilters } from "./title-filters.ts";
import type { Title, TitleKind } from "./ondemand.ts";

/** Current admitted subscription id, media type and provider id. Display names never identify members. */
export interface CollectionIdentity {
  readonly sourceId: string;
  readonly kind: TitleKind;
  readonly titleId: string;
}

/** Last known label retained when an exact source no longer lists this title. */
export interface CollectionTitle extends CollectionIdentity {
  readonly name: string;
  readonly year: number | null;
  /** Missing adult facts are treated as restricted until explicitly known. */
  readonly adult?: boolean;
}

/** The most characters a collection's name has, once trimmed. */
export const COLLECTION_NAME_MAX = 120;

export interface SmartCollectionRules {
  readonly kind: TitleKind;
  readonly filters: TitleFilters;
}

export interface PersonalCollection {
  readonly id: string;
  readonly name: string;
  readonly rules?: SmartCollectionRules;
}

/** A collection as the viewer may see it, with how many of its members they may see. */
export interface CollectionSummary extends PersonalCollection {
  readonly total: number;
}

export interface CollectionMember extends CollectionTitle {
  readonly available: boolean;
  /** Admitted exact version, with artwork selected only from permitted identities. */
  readonly title?: Title;
}

export interface CollectionPage {
  readonly members: readonly CollectionMember[];
  readonly total: number;
}

/** Commands are atomic. Orders name every visible item exactly once; hidden member slots retain their positions. */
export type CollectionChange =
  | {
      readonly kind: "create";
      readonly id: string;
      readonly name: string;
      readonly rules?: SmartCollectionRules;
    }
  | { readonly kind: "rules"; readonly id: string; readonly rules: SmartCollectionRules }
  | { readonly kind: "rename"; readonly id: string; readonly name: string }
  | { readonly kind: "delete"; readonly id: string }
  | { readonly kind: "reorder"; readonly ids: readonly string[] }
  | {
      readonly kind: "member";
      readonly id: string;
      readonly title: CollectionTitle;
      readonly present: boolean;
    }
  | {
      readonly kind: "order-members";
      readonly id: string;
      readonly titles: readonly CollectionIdentity[];
    };

/** The exact versions a change adds, removes or orders; admission checks each before storing. */
export function changedTitles(change: CollectionChange): readonly CollectionIdentity[] {
  if (change.kind === "member") return [change.title];

  return change.kind === "order-members" ? change.titles : [];
}

/** Collision-free qualified identity, including ids containing separators. */
export function collectionKey(title: CollectionIdentity): string {
  return JSON.stringify([title.sourceId, title.kind, title.titleId]);
}
