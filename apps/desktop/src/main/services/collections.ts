import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import { defined } from "@mrstreamer/core/defined";
import { ViewingErasure } from "@mrstreamer/core/viewing/service";
import type { Title } from "@mrstreamer/contracts/ondemand";
import { t } from "@mrstreamer/core/i18n";
import { Failed } from "@mrstreamer/core/failure";
import { sameProfile, type ActiveProfile } from "@mrstreamer/contracts/profiles";
import {
  changedTitles,
  collectionKey,
  type CollectionChange,
  type CollectionIdentity,
  type CollectionPage,
  type CollectionSummary,
  type CollectionTitle,
} from "@mrstreamer/contracts/collections";
import { CollectionsStore, type StoredTitle } from "../platform/collections-store.ts";
import { OnDemand } from "./ondemand.ts";
import { AdmittedSettings, Settings } from "./preferences.ts";
import { AdmittedKids, allowsApproval } from "./profile-policy.ts";
import { Subscriptions, type SavedSubscription } from "./subscription.ts";

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
  readonly catalogue: readonly (CollectionTitle & { readonly title?: Title })[];
  /** Current rule results from the admitted catalogue; never persisted as manual members. */
  readonly smart?: ReadonlyMap<string, readonly CollectionTitle[]>;
}

/**
 * Bind once to an admitted profile store and lifecycle guard. Each request supplies its captured
 * visibility; neither this module nor a suspended operation resolves the active owner again.
 * The guard must invalidate on profile/policy revision, source erasure and deletion.
 * `Collections` below supplies that visibility from the admitted context and publishes changes.
 */
export function makeCollections(
  store: CollectionsStore["Service"],
  admitted: ActiveProfile,
  current: () => boolean,
) {
  const owner = { ...admitted };

  const refused = () =>
    new Failed({
      error: {
        kind: "unexpected",
        detail: t("Collection admission has ended; retry the request."),
      },
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
          ...defined({ title: title.title }),
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

    const smart = new Map(
      [...(visibility.smart ?? [])].map(([id, titles]) => [
        id,
        titles
          .filter((title) => allows(title) && (adult || title.adult === false))
          .map((title) => ({
            ...title,
            available: true,
            ...defined({ title: catalogue.get(collectionKey(title))?.title }),
          })),
      ]),
    );

    return { allows, catalogue, stored, visible, adult, smart };
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
        members: list.rules
          ? (captured.smart.get(list.id) ?? [])
          : list.members.flatMap((saved) => {
              const member = captured.visible(saved);

              return member ? [member] : [];
            }),
      }));
    });

  return {
    list: (visibility: CollectionVisibility) =>
      Effect.map(read(visibility), (lists) =>
        lists.map(({ id, name, members, rules }) => ({
          id,
          name,
          ...defined({ rules }),
          total: members.length,
        })),
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

/** Durable policy guard captured by the public handler, never resolved from the active profile. */
export class CollectionCurrent extends Context.Service<
  CollectionCurrent,
  { readonly check: Effect.Effect<void, Failed> }
>()("mrstreamer/CollectionCurrent") {}

/** Public personal collections. Requires the real admitted context, including for adult requests. */
export class Collections extends Context.Service<
  Collections,
  {
    readonly list: Effect.Effect<readonly CollectionSummary[], Failed>;
    readonly page: (
      id: string,
      offset: number,
      limit: number,
    ) => Effect.Effect<CollectionPage, Failed>;
    readonly memberships: (title: CollectionIdentity) => Effect.Effect<readonly string[], Failed>;
    readonly change: (change: CollectionChange) => Effect.Effect<void, Failed>;
    /** Subscribes in the caller's scope; later changes are buffered until consumed. */
    readonly profileChanges: Effect.Effect<Stream.Stream<ActiveProfile>, never, Scope.Scope>;
  }
>()("mrstreamer/Collections") {
  static readonly layer = Layer.effect(
    Collections,
    Effect.gen(function* () {
      const store = yield* CollectionsStore;
      const subscriptions = yield* Subscriptions;
      const onDemand = yield* OnDemand;
      const settings = yield* Settings;
      const changes = yield* PubSub.unbounded<ActiveProfile>();

      const unavailable = () =>
        new Failed({
          error: {
            kind: "unexpected",
            detail: t("Collection catalogue is unavailable; retry the request."),
          },
        });

      const request = (extra: readonly CollectionIdentity[] = [], smartId?: string | false) =>
        Effect.gen(function* () {
          const policy = yield* Effect.serviceOption(CollectionCurrent);

          if (policy._tag === "None") return yield* unavailable();
          yield* policy.value.check;
          const admission = yield* Effect.serviceOption(AdmittedSettings);
          const kids = yield* Effect.serviceOption(AdmittedKids);
          const erasure = yield* Effect.serviceOption(ViewingErasure);

          if (admission._tag === "None" || kids._tag === "None" || erasure._tag === "None")
            return yield* unavailable();
          const { owner, current } = admission.value;
          const approved = kids.value.approved;
          const sources = yield* subscriptions.saved;

          let catalogueCurrent: Effect.Effect<void, Failed> = Effect.void;

          const stands = () =>
            current() &&
            Exit.isSuccess(Effect.runSyncExit(catalogueCurrent)) &&
            // The admitted policy read is synchronous. Recheck it inside the SQLite write
            // transaction too, under the existing profile permit, after suspended catalogue work.
            Exit.isSuccess(Effect.runSyncExit(policy.value.check)) &&
            sources.every(
              (source) => subscriptions.standsNow(source) && erasure.value.current(source.key),
            );

          if (!stands()) return yield* unavailable();
          const saved = yield* store.read;

          const identities = [
            ...extra,
            ...saved.flatMap((list) =>
              list.members.flatMap((member) => {
                const source = sources.find((source) => source.key === member.account);

                return source
                  ? [{ sourceId: source.id, kind: member.kind, titleId: member.titleId }]
                  : [];
              }),
            ),
          ];

          const permitted = identities.filter((identity) =>
            allowsApproval(approved, {
              kind: identity.kind,
              subscriptionId: identity.sourceId,
              id: identity.titleId,
            }),
          );

          const adult = approved === null && ((yield* settings.get).adultTitles ?? false);
          const catalogue: (CollectionTitle & { readonly title: Title })[] = [];

          // Resolve each exact saved version separately. The existing catalogue admission filters
          // before grouping and artwork; a sibling version must never become this member's primary.
          const statuses = yield* onDemand.status;

          const loadedSources = statuses.lists
            .filter((list) => list.fetchedAt !== null)
            .map((list) => list.subscriptionId);

          const evaluating = saved.filter(
            (list) =>
              list.rules && smartId !== false && (smartId === undefined || list.id === smartId),
          );

          const snapshot = yield* onDemand.catalogueSnapshot(
            evaluating.length > 0
              ? [...permitted.map((identity) => identity.sourceId), ...loadedSources]
              : permitted.map((identity) => identity.sourceId),
          );

          catalogueCurrent = snapshot.current;

          for (const identity of new Map(
            permitted.map((item) => [collectionKey(item), item]),
          ).values()) {
            const status = statuses.lists.find(
              (status) => status.subscriptionId === identity.sourceId,
            );

            if (!status || status.fetchedAt === null) return yield* unavailable();

            const titles = yield* onDemand
              .titles(identity.kind, [{ subscriptionId: identity.sourceId, id: identity.titleId }])
              .pipe(
                Effect.provideService(AdmittedKids, {
                  approved: [
                    {
                      kind: identity.kind,
                      subscriptionId: identity.sourceId,
                      id: identity.titleId,
                    },
                  ],
                }),
              );

            let title = titles.find(
              (title) =>
                title.id === identity.titleId && title.subscriptionId === identity.sourceId,
            );

            // Exact adult rows stand alone in the unrestricted catalogue. Only a genuinely
            // admitted adult with adult titles enabled may read these otherwise filtered facts.
            if (!title && adult) {
              const unrestricted = yield* onDemand.titles(identity.kind, [
                { subscriptionId: identity.sourceId, id: identity.titleId },
              ]);

              title = unrestricted.find(
                (title) =>
                  title.adult &&
                  title.id === identity.titleId &&
                  title.subscriptionId === identity.sourceId,
              );
            }

            if (title)
              catalogue.push({
                ...identity,
                name: title.title,
                year: title.year,
                adult: title.adult,
                title,
              });
          }

          const smart = new Map<string, CollectionTitle[]>();
          const ruleCacheSize = saved.filter((collection) => collection.rules).length + 2;

          for (const list of evaluating) {
            if (!list.rules) continue;
            const matches: CollectionTitle[] = [];

            const page = yield* onDemand.collection(
              {
                kind: list.rules.kind,
                id: "all",
                offset: 0,
                limit: Number.MAX_SAFE_INTEGER,
                // A source first accepted during this read belongs to the next snapshot.
                filters: {
                  ...list.rules.filters,
                  sourceIds: loadedSources.filter(
                    (id) =>
                      !list.rules?.filters.sourceIds || list.rules.filters.sourceIds.includes(id),
                  ),
                },
              },
              ruleCacheSize,
            );

            for (const title of page.titles) {
              const member = {
                sourceId: title.subscriptionId,
                kind: title.kind,
                titleId: title.id,
                name: title.title,
                year: title.year,
                adult: title.adult,
                title,
              };

              catalogue.push(member);
              matches.push(member);
            }

            smart.set(list.id, matches);
          }

          if (!stands()) return yield* unavailable();

          const visibility: CollectionVisibility = {
            owner,
            sources,
            adult,
            // An omitted row can be newly adult as well as unavailable. Without permission to
            // read adult facts, no saved label or count can stand in for current admission.
            approved: adult ? "all" : catalogue,
            catalogue,
            smart,
          };

          yield* policy.value.check;

          return { module: makeCollections(store, owner, stands), visibility, owner };
        });

      return {
        list: Effect.flatMap(request(), ({ module, visibility }) => module.list(visibility)),
        page: (id, offset, limit) =>
          Effect.flatMap(request([], id), ({ module, visibility }) =>
            module.page(visibility, id, offset, limit),
          ),
        memberships: (title) =>
          Effect.gen(function* () {
            const { module, visibility } = yield* request([title], false);
            const lists = yield* module.list(visibility);
            const ids: string[] = [];

            for (const list of lists) {
              if (list.rules) continue;

              for (let offset = 0; offset < list.total; offset += 200) {
                const page = yield* module.page(visibility, list.id, offset, 200);

                if (page.members.some((member) => collectionKey(member) === collectionKey(title))) {
                  ids.push(list.id);
                  break;
                }
              }
            }

            return ids;
          }),
        change: (input) =>
          Effect.gen(function* () {
            // Copied before the first await, like the module's other caller-owned input.
            const change = structuredClone(input);
            const { module, visibility, owner } = yield* request(changedTitles(change), false);
            yield* module.change(visibility, change);
            yield* PubSub.publish(changes, owner);
          }),
        profileChanges: Effect.map(PubSub.subscribe(changes), Stream.fromSubscription),
      } satisfies Collections["Service"];
    }),
  );
}
