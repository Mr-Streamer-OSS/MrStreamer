// Movies' and Series' Collections tab, as Paper A3 draws it: the viewer's collections in a
// column, and the one open beside it as a grid of its members in their saved order. Each member
// is the exact source version that was added. One its subscription still lists opens that
// version's details; one it no longer lists is dimmed, says Unavailable and can be removed.
//   The ring at a poster's corner picks it, and so does pressing an unavailable one. Once one is
// picked the bar over the grid adds the picked titles to another collection or removes them from
// this one, and Done drops the pick. Watchlist stays apart, as Save in a title's details.
//   A smart collection (see SmartRules.tsx) shows its rules over its matches instead, and its
// picks only go to other manual collections. New collection makes either, a smart one of the
// tab's kind; until its first rule is saved it is a draft in the column, gone with the view.
import { Menu } from "@base-ui/react/menu";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";
import {
  collectionKey,
  type CollectionChange,
  type CollectionMember,
  type CollectionSummary,
} from "@mrstreamer/contracts/collections";
import type { TitleKind } from "@mrstreamer/contracts/ondemand";
import { formatDate, t } from "@mrstreamer/core/i18n";
import { openDetails } from "../../app/ui-store.ts";
import { PosterContent } from "../../components/TitleArt.tsx";
import { Button } from "../../components/ui/button.tsx";
import { menuItem, menuSurface } from "../../components/ui/menu.ts";
import { appError, describeError } from "../../lib/errors.ts";
import { profileOwner } from "../../lib/ipc.ts";
import { useSourceOf } from "../../lib/queries.ts";
import { cn } from "../../lib/utils.ts";
import { kindLabel } from "../../lib/watchlist.ts";
import { Grid, PAGE, usePages, type GridTile } from "../titles/CollectionGrid.tsx";
import {
  CollectionNav,
  problemOf,
  type CollectionProblem,
  type SmartDraft,
} from "./CollectionControls.tsx";
import { collectionQueries, useCollectionUpdates, useCommitCollection } from "./collections.ts";
import { SmartPane } from "./SmartRules.tsx";

/** The collection last opened, kept while the viewer goes elsewhere and between both tabs. */
const useOpen = create<{ id: string | null }>(() => ({ id: null }));

/** `kind` is the tab's, which a new smart collection matches. */
export function CollectionsPage({ kind, active }: { kind: TitleKind; active: boolean }) {
  return <OwnedCollections key={JSON.stringify(profileOwner())} kind={kind} active={active} />;
}

function OwnedCollections({ kind, active }: { kind: TitleKind; active: boolean }) {
  useCollectionUpdates();
  const list = useQuery(collectionQueries.list());
  const commit = useCommitCollection();
  const opened = useOpen((state) => state.id);
  const collections = list.data;
  // A smart collection named here and given no saved rule yet.
  const [draft, setDraft] = useState<(SmartDraft & { kind: TitleKind }) | null>(null);

  // Once stored, the draft is a collection like the others.
  if (draft && collections?.some((each) => each.id === draft.id)) setDraft(null);

  const drafting =
    draft && opened === draft.id && !collections?.some((each) => each.id === draft.id);

  const lastOpen = useRef<string | null>(null);

  // The one opened, while the viewer still has it, else their first.
  const open = collections?.find((each) => each.id === opened) ?? collections?.[0] ?? null;

  if (collections) lastOpen.current = open?.id ?? null;
  const id = collections ? open?.id : lastOpen.current;

  return (
    <div className="flex min-h-0 flex-1 pl-10">
      <div className="w-56 flex-none overflow-y-auto pr-6 pb-10">
        {list.error ? <Failure error={list.error} onRetry={() => void list.refetch()} /> : null}
        <CollectionNav
          collections={collections ?? []}
          ready={!!collections}
          selected={drafting ? draft.id : (open?.id ?? null)}
          onOpen={(id) => useOpen.setState({ id })}
          commit={commit}
          draft={draft}
          onSmart={(named) => {
            setDraft({ ...named, kind });
            useOpen.setState({ id: named.id });
          }}
        />
        {!collections && !list.error && (
          <p className="px-3 text-[0.8125rem] text-muted-foreground">{t("Loading…")}</p>
        )}
      </div>
      {drafting ? (
        <SmartPane
          key={draft.id}
          kind={draft.kind}
          name={draft.name}
          saved={null}
          savedTotal={null}
          change={(filters) => ({
            kind: "create",
            id: draft.id,
            name: draft.name,
            rules: { kind: draft.kind, filters },
          })}
          onDiscard={() => setDraft(null)}
          active={active}
        >
          {null}
        </SmartPane>
      ) : (
        id && (
          <Members
            key={id}
            id={id}
            collection={open}
            // Picks go only where members are added: rules decide a smart collection's.
            others={collections?.filter((each) => each.id !== id && !each.rules) ?? []}
            active={active}
            commit={commit}
          />
        )
      )}
    </div>
  );
}

/** Why a read failed, with Try again. Nothing is shown as empty in its place. */
function Failure({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <p role="alert" className="px-3 text-[0.8125rem]">
      <span className="text-destructive">{describeError(appError(error))}</span>{" "}
      <button onClick={onRetry} className="text-white underline underline-offset-4">
        {t("Try again")}
      </button>
    </p>
  );
}

/** One collection's members, a page at a time as the grid asks, with the bar for those picked. */
function Members({
  id,
  collection,
  others,
  active,
  commit,
}: {
  id: string;
  collection: CollectionSummary | null;
  others: readonly CollectionSummary[];
  active: boolean;
  commit: (change: CollectionChange | readonly CollectionChange[]) => Promise<void>;
}) {
  const { pages, load } = usePages(id);

  const loaded = useQueries({
    queries: pages.map((page) => collectionQueries.page(id, page * PAGE, PAGE)),
  });

  const byPage = new Map(pages.map((page, index) => [page, loaded[index]?.data]));
  const total = byPage.get(0)?.total ?? null;
  const error = loaded.find((each) => each.error)?.error ?? null;
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());

  const complete = !!collection && loaded.every((each) => each.isSuccess);

  // Keep only current admitted page members, including their latest display facts.
  const admitted = new Map(
    [...byPage.values()]
      .flatMap((page) => page?.members ?? [])
      .map((member) => [collectionKey(member), member]),
  );

  const selected = [...picked].flatMap((key) => {
    const member = admitted.get(key);

    return member ? [member] : [];
  });

  useEffect(() => {
    if (complete && selected.length !== picked.size)
      setPicked(new Set(selected.map(collectionKey)));
  });

  const pick = (member: CollectionMember) =>
    setPicked((now) => {
      const next = new Set(now);
      const key = collectionKey(member);

      if (!next.delete(key)) next.add(key);

      return next;
    });

  const rules = collection?.rules;
  // Matches already shown stay while a later read of them fails; they were admitted when read.
  const first = loaded[0];
  const stale = !!rules && !!error && total !== null;

  const grid = (
    <Grid
      total={total ?? 0}
      itemAt={(index) => byPage.get(Math.floor(index / PAGE))?.members[index % PAGE]}
      keyOf={collectionKey}
      onVisible={load}
      settled={loaded.every((each) => !each.isFetching)}
      active={active}
      // Each member opens the version that was added, even where the title shows another.
      onOpen={(member) =>
        member.title
          ? openDetails({
              kind: member.kind,
              subscriptionId: member.sourceId,
              id: member.titleId,
              asked: true,
            })
          : pick(member)
      }
      tile={(member, grid) => (
        <MemberTile
          member={member}
          grid={grid}
          picked={picked.has(collectionKey(member))}
          picking={picked.size > 0}
          onPick={() => pick(member)}
        />
      )}
    />
  );

  const body: ReactNode = (
    <>
      {picked.size > 0 && (
        <Picked
          key={JSON.stringify([...picked])}
          collection={collection}
          ready={!!collection && selected.length === picked.size}
          others={others}
          picked={selected}
          commit={commit}
          onDone={() => setPicked(new Set())}
        />
      )}
      {!collection ? null : stale ? (
        grid
      ) : error ? (
        <Failure error={error} onRetry={() => loaded.forEach((each) => void each.refetch())} />
      ) : total === 0 ? (
        rules ? (
          <div className="flex flex-col gap-1.5">
            <p className="text-[0.9375rem] text-white">{t("No titles match these rules.")}</p>
            <p className="text-[0.8125rem] text-muted-foreground">
              {t("Titles appear here when your sources add them.")}
            </p>
          </div>
        ) : (
          <p className="text-[0.9375rem] text-muted-foreground">
            {t("Add movies and series to it from their details.")}
          </p>
        )
      ) : (
        total !== null && grid
      )}
    </>
  );

  if (collection && rules)
    return (
      <SmartPane
        kind={rules.kind}
        name={collection.name}
        saved={rules.filters}
        savedTotal={total}
        change={(filters) => ({ kind: "rules", id, rules: { kind: rules.kind, filters } })}
        active={active}
        notes={
          stale &&
          first && (
            <p role="alert" className="text-[0.8125rem]">
              <span className="text-destructive">
                {t("Couldn't refresh your sources. Showing matches from {time}.", {
                  time: formatDate(first.dataUpdatedAt, "time"),
                })}
              </span>{" "}
              <button
                onClick={() => loaded.forEach((each) => void each.refetch())}
                className="text-white underline underline-offset-4"
              >
                {t("Try again")}
              </button>
            </p>
          )
        }
      >
        {body}
      </SmartPane>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-baseline gap-2.5 pr-8 pb-4">
        <h1 className="truncate text-[1.625rem] leading-8 font-bold tracking-[-0.02em]">
          {collection?.name}
        </h1>
        {collection && total !== null && (
          <span className="flex-none text-[0.8125rem] text-muted-foreground tabular-nums">
            {t("{count} titles", { count: total })}
          </span>
        )}
      </div>
      {body}
    </div>
  );
}

/** A member's poster, with the ring that picks it. Both are the tile's controls in the grid. */
function MemberTile({
  member,
  grid,
  picked,
  picking,
  onPick,
}: {
  member: CollectionMember;
  grid: GridTile;
  picked: boolean;
  /** Something is picked, so every ring shows. */
  picking: boolean;
  onPick: () => void;
}) {
  const sourceOf = useSourceOf();
  const { title } = member;
  const name = title?.title ?? member.name;
  const facts = [kindLabel(member.kind), title?.year ?? member.year, title && sourceOf(title)];
  const said = [name, !title && t("Unavailable"), ...facts].filter(Boolean);

  return (
    <div className="group relative min-w-0">
      <button
        tabIndex={grid.tabIndex}
        aria-label={said.join(", ")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={grid.open}
        className="block w-full min-w-0 text-left outline-none"
        title={title?.name}
      >
        <PosterContent
          artworkUrl={title?.posterUrl ?? null}
          name={name}
          selected={grid.selected || picked}
          unavailable={!title}
          caption={said.slice(1).join(" · ")}
        />
      </button>
      <button
        role="checkbox"
        aria-checked={picked}
        aria-label={t("Select {name}", { name })}
        tabIndex={grid.tabIndex}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onPick}
        className={cn(
          "absolute top-2 left-2 grid size-[22px] place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring",
          picked
            ? "bg-foreground text-black"
            : "bg-black/30 shadow-[inset_0_0_0_1.5px_rgb(255_255_255/60%)]",
          !picking && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
        )}
      >
        {picked && <Check className="size-[13px]" strokeWidth={3} />}
      </button>
    </div>
  );
}

/**
 * "3 selected", with Add to collection, Remove from this one (unless rules pick its members) and
 * Done. Each sends one change per title, in order; a refused one says so, and Retry sends them all
 * again, which stores each once.
 */
function Picked({
  collection,
  ready,
  others,
  picked,
  commit,
  onDone,
}: {
  collection: CollectionSummary | null;
  ready: boolean;
  others: readonly CollectionSummary[];
  picked: readonly CollectionMember[];
  commit: (changes: readonly CollectionChange[]) => Promise<void>;
  onDone: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const [failed, setFailed] = useState<{
    readonly targets: readonly { id: string; present: boolean; key: string }[];
    readonly problem: CollectionProblem;
    readonly then: () => void;
  } | null>(null);

  // `then` follows once they are all stored, after Retry too.
  const send = async (changes: readonly CollectionChange[], then = () => {}) => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setFailed(null);

    try {
      await commit(changes);

      if (mounted.current) then();
    } catch (cause) {
      if (!mounted.current) return;

      setFailed({
        targets: changes.flatMap((change) =>
          change.kind === "member"
            ? [{ id: change.id, present: change.present, key: collectionKey(change.title) }]
            : [],
        ),
        problem: problemOf(cause),
        then,
      });
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  // Operation identity survives an unknown admission; no old labels or posters are rendered.
  if (!ready || !collection || picked.length === 0) return null;

  const member = (id: string, title: CollectionMember, present: boolean): CollectionChange => ({
    kind: "member",
    id,
    title: { sourceId: title.sourceId, kind: title.kind, titleId: title.titleId, ...label(title) },
    present,
  });

  // Only titles a subscription lists now can go in another collection.
  const available = picked.filter((each) => each.title);
  const count = t("{count} selected", { count: picked.length });

  return (
    <div className="flex-none pr-8 pb-5">
      <div role="group" aria-label={count} className="flex min-h-11 flex-wrap items-center gap-2">
        <span className="text-[0.8125rem] font-semibold tabular-nums">{count}</span>
        <span className="grow" />
        <Menu.Root>
          <Menu.Trigger
            disabled={saving || others.length === 0 || available.length === 0}
            render={<Button size="sm" />}
          >
            {t("Add to collection")}
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-[60]">
              <Menu.Popup
                aria-label={t("Add to collection")}
                className={cn(
                  menuSurface,
                  "max-h-[min(60vh,var(--available-height))] w-[15rem] overflow-y-auto text-[0.875rem] text-white",
                )}
              >
                {others.map((other) => (
                  <Menu.Item
                    key={other.id}
                    closeOnClick
                    onClick={() => void send(available.map((each) => member(other.id, each, true)))}
                    className={cn(menuItem, "flex h-9 items-center px-2")}
                  >
                    <span className="min-w-0 flex-1 truncate">{other.name}</span>
                  </Menu.Item>
                ))}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
        {!collection.rules && (
          <Button
            size="sm"
            disabled={saving}
            onClick={() =>
              void send(
                picked.map((each) => member(collection.id, each, false)),
                onDone,
              )
            }
          >
            {t("Remove from {name}", { name: collection.name })}
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onDone}>
          {t("Done")}
        </Button>
      </div>
      {failed && (
        <p role="alert" className="flex items-baseline gap-3 pt-1 text-xs">
          <span className="text-destructive">{failed.problem.text}</span>
          <button
            onClick={() =>
              failed.problem.retry
                ? void send(
                    failed.targets.map((target) =>
                      member(
                        target.id,
                        picked.find((each) => collectionKey(each) === target.key)!,
                        target.present,
                      ),
                    ),
                    failed.then,
                  )
                : setFailed(null)
            }
            className="text-white underline"
          >
            {failed.problem.retry ? t("Retry") : t("Close")}
          </button>
        </p>
      )}
    </div>
  );
}

/** What a member command carries besides its identity; the main process keeps its own facts. */
function label(member: CollectionMember) {
  return { name: member.title?.title ?? member.name, year: member.title?.year ?? member.year };
}
