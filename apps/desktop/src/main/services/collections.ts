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
import type { CollectionsStore } from "../platform/collections-store.ts";

/** Main-process captured policy only. An empty approval list denies every member. */
export interface CollectionVisibility {
  readonly owner: ActiveProfile;
  readonly sourceIds: readonly string[];
  readonly approved: "all" | readonly CollectionIdentity[];
  /** Exact, ungrouped source rows. Filter before selecting labels or counting members. */
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
    const sources = new Set(visibility.sourceIds);

    const approved =
      visibility.approved === "all" ? null : new Set(visibility.approved.map(collectionKey));

    const allows = (title: CollectionIdentity) =>
      sources.has(title.sourceId) && (approved === null || approved.has(collectionKey(title)));

    const catalogue = new Map(
      visibility.catalogue.filter(allows).map((title) => [
        collectionKey(title),
        {
          sourceId: title.sourceId,
          kind: title.kind,
          titleId: title.titleId,
          name: title.name,
          year: title.year,
        },
      ]),
    );

    return { allows, catalogue };
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
        members: list.members.filter(captured.allows).map((saved) => {
          const title = captured.catalogue.get(collectionKey(saved));

          return { ...(title ?? saved), available: title !== undefined };
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
          return yield* refused();
        const lists = yield* read(visibility);
        const list = lists.find((list) => list.id === id);

        if (!list) return yield* refused();

        return { total: list.members.length, members: list.members.slice(offset, offset + limit) };
      }),
    change: (visibility: CollectionVisibility, change: CollectionChange) =>
      Effect.gen(function* () {
        const captured = yield* attempt(() => capture(visibility));
        // Snapshot command data too; queued callers cannot retarget a member across an await.
        const command = structuredClone(change);

        if (
          (command.kind === "member" && !captured.allows(command.title)) ||
          (command.kind === "order-members" &&
            command.titles.some((title) => !captured.allows(title)))
        )
          return yield* refused();
        // The store checks the guard inside its transaction; once committed, the change is stored.
        yield* store.change(command, current);
      }),
  };
}
