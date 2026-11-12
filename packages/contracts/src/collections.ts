import { type } from "arktype";
import { lazy, type Infer } from "./lazy.ts";
import { TitleFilters } from "./title-filters.ts";
import { TITLE_KINDS, type Title, type TitleKind } from "./ondemand.ts";

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

/** One kind's saved discovery filters. A collection with rules is smart: they pick its members. */
export const SmartCollectionRules = lazy(() =>
  type({ kind: type.enumerated(...TITLE_KINDS), filters: TitleFilters() }),
);

export type SmartCollectionRules = Infer<typeof SmartCollectionRules>;

const Reversed = lazy(() =>
  type({ min: "number", max: "number" }).narrow((range) => range.min > range.max),
);

// Filters as a collection keeps them, each one on its own: known keys only and no reversed range.
const StrictFilters = lazy(() =>
  TitleFilters()
    .onDeepUndeclaredKey("reject")
    .narrow((filters) => !Object.values(filters).some((value) => Reversed().allows(value))),
);

/**
 * Rules as commands send them and the store keeps them: known keys only, some filter and no
 * reversed range. Evaluation ignores what a version doesn't know, so looser rules would pick
 * more members than they say.
 */
export const StrictSmartCollectionRules = lazy(() =>
  type({ kind: type.enumerated(...TITLE_KINDS), filters: StrictFilters() })
    .onUndeclaredKey("reject")
    .narrow(({ filters }) => Object.keys(filters).length > 0),
);

/** Why saved rules are withheld. Parts this version doesn't know are never named. */
export type WithheldRulesProblem =
  | { readonly reason: "unreadable" | "unknown-kind" | "unknown-parts" | "no-filters" }
  /** A known filter whose saved value this version refuses, such as a reversed range. */
  | { readonly reason: "invalid-filter"; readonly filter: keyof TitleFilters };

/**
 * Saved rules failing `StrictSmartCollectionRules`. Their collection has no members until a
 * `rules` change replaces them; the saved rules stay as they are until then.
 */
export interface WithheldRules {
  /** The saved kind, when this version knows it. */
  readonly kind?: TitleKind;
  /** The saved filters this version reads as they are, to start a replacement from. Never applied. */
  readonly filters: TitleFilters;
  readonly problems: readonly WithheldRulesProblem[];
}

const Saved = lazy(() => type("string.json.parse").pipe(StrictSmartCollectionRules()));

// Any rules-shaped JSON, to say what failing rules still hold.
const AnySavedRules = lazy(() =>
  type("string.json.parse").pipe(type({ "kind?": "unknown", filters: { "[string]": "unknown" } })),
);

/** Rules as saved in JSON, applied only when they pass `StrictSmartCollectionRules`. */
export function savedRules(
  json: string,
): { readonly rules: SmartCollectionRules } | { readonly withheld: WithheldRules } {
  const rules = Saved()(json);

  if (!(rules instanceof type.errors)) return { rules };
  const saved = AnySavedRules()(json);

  if (saved instanceof type.errors)
    return { withheld: { filters: {}, problems: [{ reason: "unreadable" }] } };

  const kind = TITLE_KINDS.find((kind) => kind === saved.kind);
  const known = TitleFilters().keyof();
  const entries = Object.entries(saved.filters);
  const readable = entries.filter(([filter, value]) => StrictFilters().allows({ [filter]: value }));

  const problems: WithheldRulesProblem[] = [
    ...(kind ? [] : [{ reason: "unknown-kind" } as const]),
    ...entries.flatMap(([filter, value]) =>
      known.allows(filter) && !StrictFilters().allows({ [filter]: value })
        ? [{ reason: "invalid-filter", filter } as const]
        : [],
    ),
    ...(Object.keys(saved).some((key) => key !== "kind" && key !== "filters") ||
    entries.some(([filter]) => !known.allows(filter))
      ? [{ reason: "unknown-parts" } as const]
      : []),
    ...(entries.length === 0 ? [{ reason: "no-filters" } as const] : []),
  ];

  return {
    withheld: {
      ...(kind && { kind }),
      // Filters are checked one by one, so those passing alone pass together.
      filters: StrictFilters().assert(Object.fromEntries(readable)),
      problems,
    },
  };
}

export interface PersonalCollection {
  readonly id: string;
  readonly name: string;
  readonly rules?: SmartCollectionRules;
  /** Present instead of `rules` when its saved rules are withheld: see `WithheldRules`. */
  readonly withheld?: WithheldRules;
}

/** Whether the viewer picks its members. A withheld smart collection is not manual. */
export const isManual = (collection: PersonalCollection) =>
  !collection.rules && !collection.withheld;

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
