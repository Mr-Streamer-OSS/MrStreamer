// A title's collections menu in its details, beside Save: which of the viewer's collections hold
// the version that plays, by its own subscription and provider id. Another version of the same
// film is another member. Until both reads answer nothing is ticked or offered, and a failed one
// says why with Try again rather than showing the title in no collection.
import { useQuery } from "@tanstack/react-query";
import { ListPlus } from "lucide-react";
import type { CollectionIdentity } from "@mrstreamer/contracts/collections";
import type { Title } from "@mrstreamer/contracts/ondemand";
import type { OwnedId } from "@mrstreamer/contracts/subscription";
import { t } from "@mrstreamer/core/i18n";
import { Button } from "../../components/ui/button.tsx";
import { appError, describeError } from "../../lib/errors.ts";
import { CollectionMembership } from "./CollectionControls.tsx";
import { collectionQueries, useCollectionUpdates, useCommitCollection } from "./collections.ts";

/** `title` is the one the lists have, null when they don't: then it goes in no collection. */
export function TitleCollections({ title, version }: { title: Title | null; version: OwnedId }) {
  if (!title) return null;

  return (
    <Membership
      // Another version is another member, with its own answer and its own pending change.
      key={`${version.subscriptionId}:${version.id}`}
      title={title}
      identity={{ sourceId: version.subscriptionId, kind: title.kind, titleId: version.id }}
    />
  );
}

function Membership({ title, identity }: { title: Title; identity: CollectionIdentity }) {
  useCollectionUpdates();
  const list = useQuery(collectionQueries.list());
  const memberOf = useQuery(collectionQueries.memberships(identity));
  const commit = useCommitCollection();
  const error = list.error ?? memberOf.error;

  if (error)
    return (
      <p role="alert" className="text-sm">
        <span className="text-destructive">{describeError(appError(error))}</span>{" "}
        <button
          onClick={() => {
            if (list.error) void list.refetch();

            if (memberOf.error) void memberOf.refetch();
          }}
          className="text-white underline underline-offset-4"
        >
          {t("Try again")}
        </button>
      </p>
    );

  if (!list.data || !memberOf.data)
    return (
      <Button variant="secondary" size="lg" disabled aria-busy>
        <ListPlus />
        {t("Add to collection")}
      </Button>
    );

  return (
    <CollectionMembership
      title={{ ...identity, name: title.title, year: title.year }}
      collections={list.data}
      memberOf={new Set(memberOf.data)}
      commit={commit}
    />
  );
}
