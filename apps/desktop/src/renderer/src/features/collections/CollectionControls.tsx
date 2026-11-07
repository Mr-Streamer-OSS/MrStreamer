// The viewer's own collections, as Paper A3 draws them: a column of collections with their counts
// and New collection, each with Rename, Move up, Move down and Delete collection, and a title's
// "Add to collection" menu that ticks every collection holding it. Watchlist stays Save, apart.
//   Both are controlled. They show what they are given and send each change through `commit`,
// one atomic `CollectionChange`, then wait for new props: nothing is shown as saved before it is.
// A member is the exact source version given as `title`, never every title of the same name.
import { Menu } from "@base-ui/react/menu";
import { Check, Ellipsis, ListPlus, Plus } from "lucide-react";
import { useEffect, useId, useRef, useState, type SyntheticEvent } from "react";
import {
  COLLECTION_NAME_MAX,
  type CollectionChange,
  type CollectionSummary,
  type CollectionTitle,
} from "@mrstreamer/contracts/collections";
import { failedWith } from "@mrstreamer/core/failure";
import { t } from "@mrstreamer/core/i18n";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { menuItem, menuSurface } from "../../components/ui/menu.ts";
import { cn } from "../../lib/utils.ts";
import { describeError } from "../../lib/errors.ts";

/** Sends one change; resolves once it is stored, rejects when it was not. */
export type CommitCollection = (change: CollectionChange) => Promise<void>;

/** Keeps a menu's keys and clicks from the row or page behind its portal. */
const keep = (event: SyntheticEvent) => event.stopPropagation();

/** What a refused change says, and whether sending it again could store it. */
export interface CollectionProblem {
  readonly text: string;
  readonly retry: boolean;
}

/** A refusal the viewer can act on says why and offers no Retry; any other offers Retry. */
export function problemOf(cause: unknown): CollectionProblem {
  // Failed is a main-process value; renderer adapters usually reject AppFailure.
  const typed = failedWith(cause).error;

  const actionable =
    typed.kind === "list-name-taken" ||
    typed.kind === "no-list" ||
    typed.kind === "list-changed" ||
    typed.kind === "title-not-found";

  return {
    text:
      typed.kind === "title-not-found"
        ? t("This title isn't available here.")
        : actionable
          ? describeError(typed)
          : t("Couldn't save."),
    retry: !actionable,
  };
}

/**
 * One change at a time. `run` resolves whether it was stored; a refused one is kept as `failed`,
 * so the control that sent it can say so and send it again.
 */
function useCommit(commit: CommitCollection, ready: boolean) {
  const admitted = useRef(ready);
  admitted.current = ready;
  const requested = useRef<CollectionChange | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<CollectionChange | null>(null);
  const busy = useRef(false);
  const generation = useRef(0);
  const [problem, setProblem] = useState<CollectionProblem | null>(null);

  useEffect(
    () => () => {
      admitted.current = false;
      generation.current++;
      requested.current = null;
    },
    [],
  );

  const dismiss = () => {
    generation.current++;
    requested.current = null;
    setFailed(null);
    setProblem(null);
  };

  const run = async (change: CollectionChange) => {
    if (busy.current || !admitted.current) return false;
    requested.current = change;
    const turn = generation.current;
    busy.current = true;
    setSaving(true);
    setFailed(null);
    setProblem(null);

    try {
      await commit(change);

      return true;
    } catch (cause) {
      if (turn === generation.current) {
        setFailed(change);
        setProblem(problemOf(cause));
      }

      return false;
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  return { saving, failed, problem, run, dismiss, requested: requested.current };
}

/**
 * A collection's name as a field. Enter or leaving it saves, Escape cancels, an unchanged or empty
 * name cancels. A refused save keeps the field and says so; Enter sends it again, leaving does not.
 */
function NameField({
  initial,
  failed,
  saving,
  onSave,
  onCancel,
}: {
  initial: string;
  saving: boolean;
  failed: string | null;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const cancelled = useRef(false);

  const save = () => {
    if (saving) return;
    const trimmed = name.trim();

    if (trimmed === "" || (trimmed === initial && !failed)) onCancel();
    else onSave(trimmed);
  };

  return (
    <div className="flex flex-col gap-1.5 py-px">
      <Input
        compact
        readOnly={saving}
        autoFocus
        aria-label={t("Collection name")}
        maxLength={COLLECTION_NAME_MAX}
        aria-invalid={!!failed || undefined}
        value={name}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => {
          if (!cancelled.current && !failed) save();
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;

          if (event.key === "Enter") save();
          else if (event.key === "Escape") {
            cancelled.current = true;
            onCancel();
          } else return;
          event.preventDefault();
          event.stopPropagation();
        }}
        className="text-[13px]"
      />
      {failed && (
        <p role="alert" className="px-3 text-xs text-destructive">
          {failed}
        </p>
      )}
    </div>
  );
}

/** New collection's button, as a focus target beside collection ids. */
const NEW = Symbol("new collection");

/** The field or question open in the column, with the collection it is for or will make. */
interface Editing {
  readonly kind: "create" | "rename" | "delete";
  readonly id: string;
}

/**
 * The column of collections. `selected` is the one open beside it, `onOpen` opens another. Every
 * control is a button or a menu, so Tab, Enter, Space and the arrow keys reach all of it.
 */
export function CollectionNav({
  collections,
  selected,
  onOpen,
  commit,
  ready = true,
}: {
  ready?: boolean;
  collections: readonly CollectionSummary[];
  selected: string | null;
  onOpen: (id: string) => void;
  commit: CommitCollection;
}) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const edit = useRef<Editing | null>(null);
  const change = useCommit(commit, ready);
  // What takes the focus once the field or question that had it goes: a row's button, or New
  // collection. Both remount after editing, so each takes it from its ref once it is back.
  const refocus = useRef<string | typeof NEW | null>(null);

  const focusIfDue = (key: string | typeof NEW) => (node: HTMLButtonElement | null) => {
    if (!node || refocus.current !== key) return;
    refocus.current = null;
    node.focus();
  };

  const close = (focus: string | typeof NEW) => {
    refocus.current = focus;
    edit.current = null;
    setEditing(null);
    change.dismiss();
  };

  const begin = (next: Editing) => {
    change.dismiss();
    edit.current = next;
    setEditing(next);
  };

  const save = async (next: CollectionChange, focus: string | typeof NEW) => {
    const started = edit.current;

    if ((await change.run(next)) && edit.current === started) close(focus);
  };

  // A reorder names every collection, in the order shown with this one moved.
  const move = (id: string, index: number, by: -1 | 1) => {
    const ids = collections.map((each) => each.id).toSpliced(index, 1);
    void change.run({ kind: "reorder", ids: ids.toSpliced(index + by, 0, id) });
  };

  const failedHere = (kind: CollectionChange["kind"]) =>
    change.failed?.kind === kind &&
    (kind === "reorder" || ("id" in change.failed && change.failed.id === editing?.id))
      ? (change.problem?.text ?? null)
      : null;

  useEffect(() => {
    if (!ready) return;

    if (
      editing &&
      editing.kind !== "create" &&
      !collections.some((each) => each.id === editing.id)
    ) {
      edit.current = null;
      setEditing(null);
      change.dismiss();
    }
  });

  if (!ready) return null;

  return (
    <nav aria-label={t("Collections")} className="flex flex-col gap-0.5 text-[13px] leading-4">
      <ul className="flex flex-col gap-0.5">
        {collections.map((collection, index) => (
          <li key={collection.id}>
            {editing?.kind === "rename" && editing.id === collection.id ? (
              <NameField
                saving={change.saving}
                initial={
                  change.requested?.kind === "rename" && change.requested.id === collection.id
                    ? change.requested.name
                    : collection.name
                }
                failed={failedHere("rename")}
                onCancel={() => close(collection.id)}
                onSave={(name) =>
                  void save({ kind: "rename", id: collection.id, name }, collection.id)
                }
              />
            ) : (
              <div
                className={cn(
                  "group flex h-[34px] items-center rounded-lg pl-3 hover:bg-white/6",
                  selected === collection.id && "bg-accent hover:bg-accent",
                )}
              >
                <button
                  ref={focusIfDue(collection.id)}
                  aria-current={selected === collection.id ? "page" : undefined}
                  onClick={() => onOpen(collection.id)}
                  className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md text-left text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="min-w-0 flex-1 truncate">{collection.name}</span>
                  <span className="flex-none text-xs text-muted-foreground tabular-nums">
                    {collection.total}
                  </span>
                </button>
                <CollectionOptions
                  name={collection.name}
                  saving={change.saving}
                  first={index === 0}
                  last={index === collections.length - 1}
                  onRename={() => begin({ kind: "rename", id: collection.id })}
                  onMove={(by) => move(collection.id, index, by)}
                  onDelete={() => begin({ kind: "delete", id: collection.id })}
                />
              </div>
            )}
            {editing?.kind === "delete" && editing.id === collection.id && (
              <ConfirmDelete
                name={collection.name}
                failed={failedHere("delete")}
                saving={change.saving}
                retry={change.problem?.retry ?? true}
                onCancel={() => close(collection.id)}
                onDelete={() => void save({ kind: "delete", id: collection.id }, NEW)}
              />
            )}
          </li>
        ))}
      </ul>
      {editing?.kind === "create" ? (
        <NameField
          saving={change.saving}
          initial={change.requested?.kind === "create" ? change.requested.name : ""}
          failed={failedHere("create")}
          onCancel={() => close(NEW)}
          onSave={(name) => void save({ kind: "create", id: editing.id, name }, NEW)}
        />
      ) : (
        <button
          ref={focusIfDue(NEW)}
          // One id per field, so sending a refused create again cannot make a second collection.
          onClick={() => begin({ kind: "create", id: crypto.randomUUID() })}
          className="flex h-[34px] items-center gap-2 rounded-lg px-3 text-muted-foreground outline-none hover:bg-white/6 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus className="size-3.5 flex-none" />
          {t("New collection")}
        </button>
      )}
      {failedHere("reorder") && (
        // Moving again rebuilds the order from what is shown now, so this offers no Retry.
        <p role="alert" className="flex items-baseline gap-3 px-3 py-1 text-xs">
          <span className="min-w-0 flex-1 text-destructive">{change.problem?.text}</span>
          <button onClick={change.dismiss} className="flex-none text-white underline">
            {t("Close")}
          </button>
        </p>
      )}
    </nav>
  );
}

/** A collection's options: Rename, Move up, Move down and Delete collection. */
function CollectionOptions({
  name,
  first,
  last,
  saving,
  onRename,
  onMove,
  onDelete,
}: {
  name: string;
  saving: boolean;
  first: boolean;
  last: boolean;
  onRename: () => void;
  onMove: (by: -1 | 1) => void;
  onDelete: () => void;
}) {
  const item = cn(menuItem, "flex h-9 items-center px-2 data-disabled:opacity-40");
  const label = t("Options for {list}", { list: name });

  return (
    <Menu.Root>
      <Menu.Trigger
        disabled={saving}
        aria-label={label}
        title={label}
        className="grid size-8 flex-none place-items-center rounded-full text-muted-foreground opacity-0 outline-none group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring data-popup-open:opacity-100"
      >
        <Ellipsis className="size-4" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-[60]">
          <Menu.Popup
            aria-label={label}
            className={cn(menuSurface, "w-[12rem] text-[0.875rem] text-white")}
            onKeyDown={keep}
            onClick={keep}
          >
            <Menu.Item closeOnClick onClick={onRename} className={item}>
              {t("Rename")}
            </Menu.Item>
            <Menu.Item closeOnClick disabled={first} onClick={() => onMove(-1)} className={item}>
              {t("Move up")}
            </Menu.Item>
            <Menu.Item closeOnClick disabled={last} onClick={() => onMove(1)} className={item}>
              {t("Move down")}
            </Menu.Item>
            <Menu.Separator className="mx-1 my-1 h-px bg-white/12" />
            <Menu.Item closeOnClick onClick={onDelete} className={cn(item, "text-destructive")}>
              {t("Delete collection")}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/**
 * "Delete Family night?" with Cancel, which has the focus, and Delete collection. Escape cancels.
 * Its titles stay wherever else they are; only this collection goes.
 */
function ConfirmDelete({
  name,
  failed,
  saving,
  retry,
  onCancel,
  onDelete,
}: {
  name: string;
  failed: string | null;
  saving: boolean;
  retry: boolean;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const question = t("Delete {name}?", { name });

  return (
    <div
      role="group"
      aria-label={question}
      className="flex flex-col gap-2 px-3 pt-1 pb-2.5"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onCancel();
      }}
    >
      <span role={failed ? "alert" : undefined} className={cn(failed && "text-destructive")}>
        {failed || question}
      </span>
      <div className="flex items-center gap-2">
        <Button size="sm" autoFocus onClick={onCancel}>
          {t("Cancel")}
        </Button>
        {(!failed || retry) && (
          <Button size="sm" variant="destructive" disabled={saving} onClick={onDelete}>
            {failed ? t("Retry") : t("Delete collection")}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * A title's collections menu, beside Save in its details: every collection, ticked where it holds
 * `title`, then New collection, which makes one and puts the title in it. `memberOf` names the
 * collections holding this exact source version.
 */
export function CollectionMembership({
  title,
  collections,
  memberOf,
  commit,
  ready = true,
}: {
  ready?: boolean;
  title: CollectionTitle;
  collections: readonly CollectionSummary[];
  memberOf: ReadonlySet<string>;
  commit: CommitCollection;
}) {
  const change = useCommit(commit, ready);
  const [creating, setCreating] = useState<string | null>(null);
  const draft = useRef<string | null>(null);
  const current = useRef({ ready, title });
  current.current = { ready, title };
  const labelId = useId();
  // The button comes back after the new collection's field, and takes the focus back from it.
  const refocus = useRef(false);
  const label = t("Collections for {name}", { name: title.name });

  const finish = () => {
    draft.current = null;
    setCreating(null);
    change.dismiss();
    refocus.current = true;
  };

  const failedMember = change.failed?.kind === "member" ? change.failed : null;

  useEffect(() => {
    if (ready && failedMember && !collections.some((each) => each.id === failedMember.id))
      change.dismiss();
  });

  // A refused create keeps the field to send again. Once it is stored the field closes, and a
  // refused add then offers Retry below the button like any other tick.
  const create = async (id: string, name: string) => {
    if (!(await change.run({ kind: "create", id, name }))) return;

    if (draft.current !== id || !current.current.ready) return;
    finish();
    await change.run({ kind: "member", id, title: current.current.title, present: true });
  };

  if (!ready) return null;

  if (creating !== null)
    return (
      <div className="w-[15rem]">
        <NameField
          saving={change.saving}
          initial={change.requested?.kind === "create" ? change.requested.name : ""}
          failed={change.failed?.kind === "create" ? (change.problem?.text ?? null) : null}
          onCancel={finish}
          onSave={(name) => void create(creating, name)}
        />
      </div>
    );

  return (
    <div className="flex flex-col items-start gap-2">
      <Menu.Root>
        <Menu.Trigger
          ref={(node: HTMLButtonElement | null) => {
            if (!node || !refocus.current) return;
            refocus.current = false;
            node.focus();
          }}
          aria-label={label}
          aria-labelledby={labelId}
          render={<Button variant="secondary" size="lg" aria-busy={change.saving || undefined} />}
        >
          {memberOf.size > 0 ? <Check /> : <ListPlus />}
          <span id={labelId}>
            {memberOf.size > 0
              ? t("In {count} collections", { count: memberOf.size })
              : t("Add to collection")}
          </span>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="start" sideOffset={8} className="z-[60]">
            <Menu.Popup
              aria-label={label}
              className={cn(
                menuSurface,
                "max-h-[min(60vh,var(--available-height))] w-[15rem] overflow-y-auto text-[0.875rem] text-white",
              )}
              onKeyDown={keep}
              onClick={keep}
            >
              {collections.map((collection) => (
                <Menu.CheckboxItem
                  key={collection.id}
                  disabled={change.saving}
                  checked={memberOf.has(collection.id)}
                  onCheckedChange={(present) =>
                    void change.run({ kind: "member", id: collection.id, title, present })
                  }
                  className={cn(menuItem, "group/item flex h-9 items-center gap-2.5 px-2")}
                >
                  <span className="grid size-4 flex-none place-items-center rounded-[0.25rem] shadow-[inset_0_0_0_1.5px_rgb(255_255_255/45%)] group-data-checked/item:bg-white group-data-checked/item:shadow-none">
                    <Menu.CheckboxItemIndicator>
                      <Check className="size-3 text-black" strokeWidth={3} />
                    </Menu.CheckboxItemIndicator>
                  </span>
                  <span className="min-w-0 flex-1 truncate">{collection.name}</span>
                </Menu.CheckboxItem>
              ))}
              {collections.length > 0 && <Menu.Separator className="mx-1 my-1 h-px bg-white/12" />}
              <Menu.Item
                closeOnClick
                disabled={change.saving}
                onClick={() => {
                  change.dismiss();
                  const id = crypto.randomUUID();
                  draft.current = id;
                  setCreating(id);
                }}
                className={cn(menuItem, "flex h-9 items-center gap-2.5 px-2")}
              >
                <Plus className="size-3.5 flex-none" />
                {t("New collection")}
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {failedMember && (
        <p role="alert" className="flex items-baseline gap-3 text-sm">
          <span className="text-destructive">{change.problem?.text}</span>
          <button
            onClick={() =>
              change.problem?.retry ? void change.run({ ...failedMember, title }) : change.dismiss()
            }
            className="text-white underline underline-offset-4"
          >
            {change.problem?.retry ? t("Retry") : t("Close")}
          </button>
        </p>
      )}
    </div>
  );
}
