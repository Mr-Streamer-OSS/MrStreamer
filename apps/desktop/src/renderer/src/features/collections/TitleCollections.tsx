// A title's collections menu in its details, beside Save: which of the viewer's collections hold
// the version that plays, by its own subscription and provider id. Another version of the same
// film is another member. Until both reads answer nothing is ticked or offered, and a failed one
// says why with Try again rather than showing the title in no collection, once the title is read.
import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { ListPlus } from "lucide-react";
import type { CollectionIdentity } from "@mrstreamer/contracts/collections";
import type { Title } from "@mrstreamer/contracts/ondemand";
import type { OwnedId } from "@mrstreamer/contracts/subscription";
import { t } from "@mrstreamer/core/i18n";
import { Button } from "../../components/ui/button.tsx";
import { appError, describeError } from "../../lib/errors.ts";
import { CollectionMembership } from "./CollectionControls.tsx";
import { profileOwner } from "../../lib/ipc.ts";
import { collectionQueries, useCollectionUpdates, useCommitCollection } from "./collections.ts";

/** Unknown title admission suspends controls; a completed absent title discards its operation. */
export function TitleCollections({
  title,
  version,
  pending = false,
}: {
  title: Title | null;
  version: OwnedId;
  /** True until a successful title read, including a failed read awaiting retry. */
  pending?: boolean;
}) {
  return (
    <OwnedTitleCollections
      key={JSON.stringify([profileOwner(), version.subscriptionId, version.id])}
      title={title}
      version={version}
      pending={pending}
    />
  );
}

function OwnedTitleCollections({
  title,
  version,
  pending,
}: {
  title: Title | null;
  version: OwnedId;
  pending: boolean;
}) {
  const kind = useRef(title?.kind);

  if (title) kind.current = title.kind;

  if ((!title && !pending) || !kind.current) return null;

  return (
    <Membership
      key={kind.current}
      // A failed refetch retains cached title data without fresh admission.
      title={pending ? null : title}
      identity={{ sourceId: version.subscriptionId, kind: kind.current, titleId: version.id }}
    />
  );
}

function Membership({ title, identity }: { title: Title | null; identity: CollectionIdentity }) {
  useCollectionUpdates();
  const list = useQuery(collectionQueries.list());
  const memberOf = useQuery(collectionQueries.memberships(identity));
  const commit = useCommitCollection();
  // While the title read is unresolved, the details' own alert says what failed (the same
  // catalogue read, typically); this one waits for the title, still holding its failure and retry.
  const error = title ? (list.error ?? memberOf.error) : null;

  const failure = error ? (
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
  ) : null;

  return (
    <>
      {failure}
      {!error && title && (!list.data || !memberOf.data) && (
        <Button variant="secondary" size="lg" disabled aria-busy>
          <ListPlus />
          {t("Add to collection")}
        </Button>
      )}
      <CollectionMembership
        ready={!error && !!title && !!list.data && !!memberOf.data}
        title={{ ...identity, name: title?.title ?? "", year: title?.year ?? null }}
        collections={list.data ?? []}
        memberOf={new Set(memberOf.data ?? [])}
        commit={commit}
      />
    </>
  );
}
