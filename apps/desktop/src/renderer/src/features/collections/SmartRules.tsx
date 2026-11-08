// Smart collections, as Paper A3.1 to A3.11 draw them: a collection whose members are the titles
// of one kind that match its rules now, saved from All's filters or made in the Collections tab.
// The rules are the discovery filters (see features/titles/TitleFilters.tsx), and a title matches
// when one of its versions meets every rule. Editing never saves on its own: the head and the
// Rules changed bar preview the new count from the catalogue already read, and Save rules stores
// them in one change. A refused save keeps the edits, and the column keeps the saved count.
import { Popover } from "@base-ui/react/popover";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { CollectionChange } from "@mrstreamer/contracts/collections";
import type { TitleKind } from "@mrstreamer/contracts/ondemand";
import type { TitleFilters } from "@mrstreamer/contracts/title-filters";
import { COLLECTION_NAME_MAX } from "@mrstreamer/contracts/collections";
import { t } from "@mrstreamer/core/i18n";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { menuSurface } from "../../components/ui/menu.ts";
import { profileOwner } from "../../lib/ipc.ts";
import { queries } from "../../lib/queries.ts";
import { cn } from "../../lib/utils.ts";
import { CollectionGrid, PAGE } from "../titles/CollectionGrid.tsx";
import {
  RuleMenus,
  RuleNotes,
  RuleOptionsFailure,
  sameFilters,
  setRules,
  useRuleChoices,
} from "../titles/TitleFilters.tsx";
import { problemOf, type CollectionProblem } from "./CollectionControls.tsx";
import { useCommitCollection } from "./collections.ts";

/** How many titles of `kind` match `filters` now, from the catalogue already read. */
function useMatches(kind: TitleKind, filters: TitleFilters, enabled = true) {
  // The same first page the preview grid reads, so both share one answer.
  const read = useQuery({
    ...queries.collection(kind, "all", undefined, 0, PAGE, filters),
    enabled,
  });

  return read.data && !read.isPlaceholderData ? read.data.total : null;
}

/** All's filters, saved as a smart collection of this kind. Nothing shows until one is set. */
export function SaveAsCollection({ kind, filters }: { kind: TitleKind; filters: TitleFilters }) {
  if (Object.keys(filters).length === 0) return null;

  // A switch of profile drops a half-typed name and anything it was about to send.
  return <OwnedSave key={JSON.stringify(profileOwner())} kind={kind} filters={filters} />;
}

/**
 * Save as collection, with a popover for its name, how many match now and the rules it keeps. One
 * id per popover, so Save after a refusal stores the collection once.
 */
function OwnedSave({ kind, filters }: { kind: TitleKind; filters: TitleFilters }) {
  const commit = useCommitCollection();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [id, setId] = useState(() => crypto.randomUUID());
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<CollectionProblem | null>(null);
  const count = useMatches(kind, filters, open);
  const { valueOf } = useRuleChoices(kind, filters);
  const summary = setRules(filters).flatMap((rule) => valueOf(rule) ?? []);

  const close = (next: boolean) => {
    setOpen(next);

    if (next) return;
    setName("");
    setProblem(null);
    setId(crypto.randomUUID());
  };

  const save = async () => {
    const trimmed = name.trim();

    if (trimmed === "" || saving) return;
    setSaving(true);
    setProblem(null);

    try {
      await commit({ kind: "create", id, name: trimmed, rules: { kind, filters } });
      close(false);
    } catch (cause) {
      setProblem(problemOf(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={close}>
      <Popover.Trigger render={<Button size="sm" />}>
        <Plus aria-hidden />
        {t("Save as collection")}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8} className="z-[60]">
          <Popover.Popup
            aria-label={t("Save as collection")}
            className={cn(
              menuSurface,
              "flex w-[21rem] max-w-[calc(100vw-2rem)] flex-col gap-3 p-4 text-[0.8125rem] text-white",
            )}
            // Keys typed here stay out of the grid behind the portal.
            onKeyDown={(event) => event.stopPropagation()}
          >
            <Input
              compact
              autoFocus
              aria-label={t("Collection name")}
              maxLength={COLLECTION_NAME_MAX}
              aria-invalid={!!problem || undefined}
              readOnly={saving}
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void save();
                } else if (event.key === "Escape") close(false);
              }}
              className="h-9 text-[0.8125rem]"
            />
            <p className="text-xs text-white/60">
              {count !== null && (
                <span className="text-white">
                  {kind === "movie"
                    ? t("{count} movies now.", { count })
                    : t("{count} series now.", { count })}{" "}
                </span>
              )}
              {t("Updates as your sources change.")}
              <br />
              {summary.join(" · ")}
            </p>
            {problem && (
              <p role="alert" className="text-xs text-destructive">
                {problem.text}
              </p>
            )}
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => close(false)}>
                {t("Cancel")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={saving || name.trim() === ""}
                onClick={() => void save()}
              >
                {problem?.retry ? t("Retry") : t("Save")}
              </Button>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * A smart collection open in the Collections tab: its name and count, its rules inline and, while
 * they differ from the saved ones, the Rules changed bar over a preview of what they match.
 * `saved` is null for a new one not stored yet, which saves as `change` creates it. `children` is
 * the saved matches, shown while nothing is changed; a new one has none.
 */
export function SmartPane({
  kind,
  name,
  saved,
  savedTotal,
  change,
  onDiscard,
  onSaving,
  active,
  notes,
  children,
}: {
  kind: TitleKind;
  name: string;
  saved: TitleFilters | null;
  savedTotal: number | null;
  change: (filters: TitleFilters) => CollectionChange;
  /** After Discard, for a new one, which goes. */
  onDiscard?: () => void;
  /** Keeps the local draft's name fixed while its create is being stored. */
  onSaving?: (saving: boolean) => void;
  active: boolean;
  /** Under the rules, such as a failed refresh of the saved matches. */
  notes?: ReactNode;
  children?: ReactNode;
}) {
  const [edit, setEdit] = useState<TitleFilters | null>(null);
  // Rules just stored stay shown, without the bar, until the collections read again has them.
  const [stored, setStored] = useState<TitleFilters | null>(null);
  const filters = edit ?? saved ?? {};
  const storing = stored !== null && sameFilters(stored, filters);

  const changed = !storing && (saved === null || (edit !== null && !sameFilters(edit, saved)));
  const matches = useMatches(kind, filters, changed);
  const total = changed ? matches : savedTotal;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none items-baseline gap-2.5 pr-8 pb-4">
        <h1 className="truncate text-[1.625rem] leading-8 font-bold tracking-[-0.02em]">{name}</h1>
        {total !== null && (
          <span
            className="flex-none text-[0.8125rem] text-muted-foreground tabular-nums"
            aria-live="polite"
          >
            {t("{count} titles", { count: total })}
          </span>
        )}
      </div>
      <div
        role="group"
        aria-label={t("Rules")}
        className="flex flex-none flex-wrap items-center gap-x-1 gap-y-2 pr-8 pb-4 text-[0.8125rem] text-white"
      >
        <RuleMenus kind={kind} filters={filters} onFilters={setEdit} setOnly />
      </div>
      <div className="flex flex-none flex-col gap-1 pr-8 pb-4 empty:hidden">
        <RuleNotes kind={kind} filters={filters} />
        <RuleOptionsFailure kind={kind} />
        {!changed && notes}
      </div>
      {changed && (
        <RulesChanged
          key={saved === null ? "new" : "saved"}
          isNew={saved === null}
          name={name}
          filters={filters}
          matches={matches}
          before={savedTotal}
          change={change}
          onSaved={() => setStored(filters)}
          onSaving={onSaving}
          onDiscard={() => {
            setEdit(null);
            onDiscard?.();
          }}
        />
      )}
      {changed ? (
        <CollectionGrid kind={kind} id="all" filters={filters} active={active} />
      ) : (
        children
      )}
    </div>
  );
}

/**
 * "Rules changed · 19 match, 23 before", with Discard and Save rules. A refused save keeps the
 * edits and says so, with Retry; Discard goes back to the saved rules.
 */
function RulesChanged({
  isNew,
  name,
  filters,
  matches,
  before,
  change,
  onSaved,
  onDiscard,
  onSaving,
}: {
  isNew: boolean;
  name: string;
  filters: TitleFilters;
  matches: number | null;
  before: number | null;
  change: (filters: TitleFilters) => CollectionChange;
  onSaved: () => void;
  onDiscard: () => void;
  onSaving: ((saving: boolean) => void) | undefined;
}) {
  const commit = useCommitCollection();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<{ name: string; problem: CollectionProblem } | null>(null);
  const problem = !isNew || failed?.name === name ? (failed?.problem ?? null) : null;
  const empty = Object.keys(filters).length === 0;

  const save = async () => {
    if (saving || empty) return;
    setSaving(true);
    onSaving?.(true);
    setFailed(null);

    try {
      await commit(change(filters));
      onSaved();
    } catch (cause) {
      setFailed({ name, problem: problemOf(cause) });
    } finally {
      setSaving(false);
      onSaving?.(false);
    }
  };

  const detail = empty
    ? t("Add a rule to save")
    : matches === null
      ? null
      : isNew || before === null
        ? t("{count} titles", { count: matches })
        : t("{count} match, {before} before", { count: matches, before });

  const label = isNew ? t("New smart collection") : t("Rules changed");

  return (
    <div className="flex-none pr-8 pb-5">
      <div
        role="group"
        aria-label={label}
        className="flex min-h-11 items-center gap-2 rounded-[22px] bg-accent pr-1.5 pl-4 text-[0.8125rem]"
      >
        <span className="font-semibold">{label}</span>
        {problem ? (
          <span role="alert" className="min-w-0 truncate text-destructive">
            {problem.retry ? t("Couldn't save. Your changes are kept.") : problem.text}
          </span>
        ) : (
          <span className="min-w-0 truncate text-muted-foreground tabular-nums" aria-live="polite">
            {detail}
          </span>
        )}
        <span className="grow" />
        <Button variant="ghost" size="sm" disabled={saving} onClick={onDiscard}>
          {t("Discard")}
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={saving || empty}
          aria-busy={saving || undefined}
          onClick={() => void save()}
        >
          {problem?.retry ? t("Retry") : t("Save rules")}
        </Button>
      </div>
    </div>
  );
}
