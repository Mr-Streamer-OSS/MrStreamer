import * as Effect from "effect/Effect";
import type { HandlersFor } from "../ipc.ts";
import { Failed } from "@mrstreamer/core/failure";
import { CollectionCurrent, type Collections } from "../services/collections.ts";

export function collectionsHandlers({
  collections,
  current,
}: {
  readonly collections: Collections["Service"];
  readonly current: Effect.Effect<void, Failed>;
}): HandlersFor<"collections"> {
  const admitted = <A>(work: Effect.Effect<A, Failed>) =>
    work.pipe(Effect.provideService(CollectionCurrent, { check: current }));

  return {
    "collections.list": () => admitted(collections.list),
    "collections.page": ({ id, offset, limit }) => admitted(collections.page(id, offset, limit)),
    "collections.memberships": (title) => admitted(collections.memberships(title)),
    "collections.change": (change) => admitted(Effect.as(collections.change(change), null)),
  };
}
