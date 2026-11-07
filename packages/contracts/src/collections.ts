import type { TitleKind } from "./ondemand.ts";

/** Immutable saved source id, media type and provider id. Display names never identify members. */
export interface CollectionIdentity {
  readonly sourceId: string;
  readonly kind: TitleKind;
  readonly titleId: string;
}

/** Last known label retained when an exact source no longer lists this title. */
export interface CollectionTitle extends CollectionIdentity {
  readonly name: string;
  readonly year: number | null;
}

export interface PersonalCollection {
  readonly id: string;
  readonly name: string;
}

export interface CollectionMember extends CollectionTitle {
  readonly available: boolean;
}

export interface CollectionPage {
  readonly members: readonly CollectionMember[];
  readonly total: number;
}

/** Commands are atomic. Orders must name every current item exactly once. */
export type CollectionChange =
  | { readonly kind: "create"; readonly id: string; readonly name: string }
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

/** Collision-free qualified identity, including ids containing separators. */
export function collectionKey(title: CollectionIdentity): string {
  return JSON.stringify([title.sourceId, title.kind, title.titleId]);
}
