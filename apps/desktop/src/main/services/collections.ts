import * as Effect from "effect/Effect";
import { Failed } from "@mrstreamer/core/failure";
import { sameProfile, type ActiveProfile } from "@mrstreamer/contracts/profiles";
import {
  collectionKey,
  type CollectionChange,
  type CollectionIdentity,
  type CollectionPage,
  type CollectionTitle,
} from "@mrstreamer/contracts/collections";
import type { SavedSubscription } from "./subscription.ts";
import type { CollectionsStore, StoredTitle } from "../platform/collections-store.ts";

/** Main-process captured policy only. An empty approval list denies every member. */
export interface CollectionVisibility {
  readonly owner: ActiveProfile;
  readonly adult: boolean;
  readonly sources: readonly Pick<SavedSubscription, "id" | "key">[];
  readonly approved: "all" | readonly CollectionIdentity[];
  /**
   * Successfully read, exact ungrouped source rows. Pending or failed reads must refuse the
   * request upstream with a retryable failure, never supply an empty successful catalogue.
   * Filter before selecting labels or counting members.
   */
  readonly catalogue: readonly CollectionTitle[];
}

/**
 * Bind once to an admitted profile store and lifecycle guard. Each request supplies its captured
 * visibility; neither this module nor a suspended operation resolves the active owner again.
 * The guard must invalidate on profile/policy revision, source erasure and deletion.
 * No IPC or event publication is installed here: those require the integrated kids admission.
 */
export function makeCollections(
  store: CollectionsStore["Service"],
  admitted: ActiveProfile,
  current: () => boolean,
) {
  const owner = { ...admitted };

  const refused = () =>
    new Failed({
      error: { kind: "unexpected", detail: "Collection admission has ended; retry the request." },
    });

  const check = (visibility: CollectionVisibility) => {
    if (!sameProfile(owner, visibility.owner) || !current()) throw refused();
  };

  // Copy caller-owned arrays before the first await, including their identity records.
  const capture = (visibility: CollectionVisibility) => {
    check(visibility);
    const sources = visibility.sources.map((source) => ({ id: source.id, key: source.key }));

    const approved =
      visibility.approved === "all" ? null : new Set(visibility.approved.map(collectionKey));

    const allows = (title: CollectionIdentity) =>
      sources.some((source) => source.id === title.sourceId) &&
      (approved === null || approved.has(collectionKey(title)));

    const catalogue = new Map(
      visibility.catalogue.filter(allows).map((title) => [
        collectionKey(title),
        {
          sourceId: title.sourceId,
          kind: title.kind,
          titleId: title.titleId,
          name: title.name,
          year: title.year,
          adult: title.adult !== false,
        },
      ]),
    );

    const stored = (title: CollectionIdentity) => {
      const source = sources.find((source) => source.id === title.sourceId);

      if (!source) throw new Failed({ error: { kind: "no-subscription" } });

      return { account: source.key, kind: title.kind, titleId: title.titleId };
    };

    const adult = visibility.adult;

    const visible = (saved: StoredTitle) => {
      const source = sources.find((source) => source.key === saved.account);

      if (!source) return null;
      const { account: _, ...facts } = saved;
      const identity = { ...facts, sourceId: source.id };

      if (!allows(identity)) return null;
      const title = catalogue.get(collectionKey(identity));

      if (!adult && (saved.adult !== false || title?.adult === true)) return null;

      return { ...(title ?? identity), available: title !== undefined };
    };

    return { allows, catalogue, stored, visible, adult };
  };

  const attempt = <A>(run: () => A) =>
    Effect.try({ try: run, catch: (cause) => (cause instanceof Failed ? cause : refused()) });

  const read = (visibility: CollectionVisibility) =>
    Effect.gen(function* () {
      const captured = yield* attempt(() => capture(visibility));
      const lists = yield* store.read;
      yield* attempt(() => {
        if (!current()) throw refused();
      });

      return lists.map((list) => ({
        ...list,
        members: list.members.flatMap((saved) => {
          const member = captured.visible(saved);

          return member ? [member] : [];
        }),
      }));
    });

  return {
    list: (visibility: CollectionVisibility) =>
      Effect.map(read(visibility), (lists) =>
        lists.map(({ id, name, members }) => ({ id, name, total: members.length })),
      ),
    page: (
      visibility: CollectionVisibility,
      id: string,
      offset = 0,
      limit = 48,
    ): Effect.Effect<CollectionPage, Failed> =>
      Effect.gen(function* () {
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 200
        )
          return yield* new Failed({ error: { kind: "list-changed" } });
        const lists = yield* read(visibility);
        const list = lists.find((list) => list.id === id);

        if (!list) return yield* new Failed({ error: { kind: "no-list" } });

        return { total: list.members.length, members: list.members.slice(offset, offset + limit) };
      }),
    change: (visibility: CollectionVisibility, change: CollectionChange) =>
      Effect.gen(function* () {
        const captured = yield* attempt(() => capture(visibility));
        // Snapshot command data too; queued callers cannot retarget a member across an await.
        const command = structuredClone(change);

        if (command.kind === "member" && !captured.allows(command.title))
          return yield* new Failed({
            error: { kind: "title-not-found", titleId: command.title.titleId },
          });

        if (
          command.kind === "order-members" &&
          command.titles.some((title) => !captured.allows(title))
        )
          return yield* new Failed({ error: { kind: "list-changed" } });

        // The store checks the guard inside its transaction; once committed, the change is stored.
        if (command.kind === "member") {
          const known = captured.catalogue.get(collectionKey(command.title));

          // Display fields in a command cannot authorize or lower a saved restriction.
          if (command.present && (!known || (!captured.adult && known.adult !== false)))
            return yield* new Failed({
              error: { kind: "title-not-found", titleId: command.title.titleId },
            });

          const title = known ?? command.title;
          yield* store.change(
            {
              ...command,
              title: {
                ...captured.stored(command.title),
                name: title.name,
                year: title.year,
                adult: title.adult !== false,
              },
            },
            current,
          );
        } else if (command.kind === "order-members") {
          yield* store.change(
            {
              ...command,
              titles: command.titles.map(captured.stored),
              visible: (title) => captured.visible(title) !== null,
            },
            current,
          );
        } else yield* store.change(command, current);
      }),
  };
}
