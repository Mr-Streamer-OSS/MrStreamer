// Compact menus filter this kind's grid or search, and the same menus are a smart collection's
// rules (see features/collections/SmartRules.tsx). Every rule must hold for one version of a
// title. Provider hints stay separate from tracks read on this device; asking for choices never
// opens a file or fetches details, and unknown facts never match a range.
import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Plus } from "lucide-react";
import { Fragment, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { TitleKind } from "@mrstreamer/contracts/ondemand";
import {
  QUALITY_HINTS,
  type QualityHint,
  type TitleFilters,
} from "@mrstreamer/contracts/title-filters";
import { TITLE_LANGUAGES } from "@mrstreamer/core/ondemand/languages";
import { formatLanguageName, formatNumber, t, type PlainKey } from "@mrstreamer/core/i18n";
import { Input } from "../../components/ui/input.tsx";
import { menuItem, menuSurface } from "../../components/ui/menu.ts";
import { queries, subscriptionName, useSubscriptions } from "../../lib/queries.ts";
import { appError, describeError } from "../../lib/errors.ts";
import { cn } from "../../lib/utils.ts";

const QUALITIES: Record<QualityHint, string> = {
  "4k": "4K",
  "full-hd": "Full HD",
  hd: "HD",
  sd: "SD",
  unknown: "Unknown",
};

/** Each rule's name, in the order the bar shows them. */
const RULE_NAMES = {
  genres: "Genre",
  year: "Year",
  runtime: "Runtime",
  rating: "Rating",
  watched: "Watched",
  // "Source" alone is source code, as About says.
  sourceIds: "rules.source",
  quality: "Quality",
  language: "Language",
  verified: "Verified",
} as const satisfies Record<keyof TitleFilters, PlainKey>;

type Rule = keyof typeof RULE_NAMES;

const NEEDS_OPTIONS = [
  "genres",
  "quality",
  "language",
  "verified",
] as const satisfies readonly Rule[];

const RULES: readonly Rule[] = [
  "genres",
  "year",
  "runtime",
  "rating",
  "watched",
  "sourceIds",
  "quality",
  "language",
  "verified",
];

/** Runtime picks, as inclusive bounds in seconds: "Under 90 min" ends at 89:59. */
const RUNTIMES = [
  { value: "under-90", label: "Under 90 min", range: { max: 90 * 60 - 1 } },
  { value: "under-100", label: "Under 100 min", range: { max: 100 * 60 - 1 } },
  { value: "under-120", label: "Under 2 h", range: { max: 120 * 60 - 1 } },
  { value: "over-120", label: "2 h or more", range: { min: 120 * 60 } },
] as const satisfies readonly {
  value: string;
  label: PlainKey;
  range: NonNullable<TitleFilters["runtime"]>;
}[];

const RATINGS = [6, 7, 8, 9] as const;

const WATCHED = [
  { value: "unwatched", label: "Unwatched" },
  { value: "in-progress", label: "In progress" },
  { value: "watched", label: "Watched" },
] as const satisfies readonly {
  value: NonNullable<TitleFilters["watched"]>;
  label: PlainKey;
}[];

function hintName(code: string): string {
  if (code === "unknown") return t("Unknown");

  if (code === "multi") return "MULTI";

  return TITLE_LANGUAGES.find((language) => language.code === code)?.name ?? code;
}

function verifiedName(kind: "audio" | "subtitles", language: string): string {
  const name = language === "unknown" ? t("Unknown") : (formatLanguageName(language) ?? language);

  return kind === "audio"
    ? t("{language} sound", { language: name })
    : t("{language} subtitles", { language: name });
}

function runtimeChoice(range: TitleFilters["runtime"]) {
  return RUNTIMES.find(
    (choice) =>
      range &&
      ("min" in choice.range ? choice.range.min : undefined) === range.min &&
      ("max" in choice.range ? choice.range.max : undefined) === range.max,
  );
}

function yearText(year: NonNullable<TitleFilters["year"]>): string {
  if (year.min !== undefined && year.max !== undefined)
    return t("{from} to {to}", { from: String(year.min), to: String(year.max) });

  return year.min !== undefined
    ? t("{year} or later", { year: String(year.min) })
    : t("{year} or earlier", { year: String(year.max ?? "") });
}

export interface TitleFilterControls {
  readonly filters: TitleFilters;
  readonly onFilters: (filters: TitleFilters) => void;
}

/** Keep control navigation out of the grid while leaving application shortcuts available. */
function stopGridKeys(event: KeyboardEvent) {
  if (
    [
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "Enter",
      " ",
    ].includes(event.key)
  )
    event.stopPropagation();
}

/** Escape closes the open menu only; every other key a menu handles stays out of the grid. */
function popupKeys(event: KeyboardEvent) {
  if (event.key === "Escape") event.stopPropagation();
  else stopGridKeys(event);
}

const triggerClass =
  "flex h-8 max-w-full items-center gap-2 rounded-lg px-2 text-white/70 outline-none hover:bg-white/8 hover:text-white focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 data-popup-open:bg-white/8 data-popup-open:ring-2 data-popup-open:ring-white/60";

const popupClass = cn(
  menuSurface,
  "max-h-[min(60vh,var(--available-height))] w-[min(18rem,calc(100vw-2rem))] overflow-y-auto text-[0.8125rem] text-white",
);

const itemClass = cn(
  menuItem,
  "flex items-center gap-2 px-2 py-2 text-white/70 data-checked:font-semibold data-checked:text-white",
);

/** What a trigger says: the rule's name, then its value once one is picked. */
function TriggerText({
  label,
  value,
  showLabel = true,
}: {
  label: string;
  value: string | undefined;
  showLabel?: boolean;
}) {
  return (
    <>
      {showLabel && <span className="flex-none">{label}</span>}
      {value && <span className="truncate font-semibold text-white">{value}</span>}
      {!showLabel && !value && <span>{label}</span>}
      <ChevronDown aria-hidden className="size-3.5 flex-none" />
    </>
  );
}

function Description({ children }: { children: ReactNode }) {
  return (
    <p className="mt-2 border-t border-white/15 px-2 pt-3 pb-1 text-xs text-white/60">{children}</p>
  );
}

/** Opening state shared by every rule's menu: a rule just added opens itself. */
interface Opening {
  readonly defaultOpen?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}

/** A scrollable choice menu, shared by sort and filters. Native menu keys stay out of the grid. */
export function TitleChoiceMenu<V extends string>({
  label,
  description,
  choices,
  value,
  onChange,
  disabled = false,
  clearable = false,
  showLabel = true,
  ...opening
}: {
  label: string;
  description?: string;
  choices: readonly { readonly value: V; readonly label: string }[];
  value: V | undefined;
  onChange: (value: V | undefined) => void;
  disabled?: boolean;
  clearable?: boolean;
  showLabel?: boolean;
} & Opening) {
  const selected = choices.find((choice) => choice.value === value);

  return (
    <div role="group" aria-label={label} onKeyDown={stopGridKeys}>
      <Menu.Root {...opening}>
        <Menu.Trigger
          disabled={disabled}
          aria-label={[label, selected?.label].filter(Boolean).join(": ")}
          className={triggerClass}
        >
          <TriggerText label={label} value={selected?.label} showLabel={showLabel} />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="start" sideOffset={8} className="z-[60]">
            <Menu.Popup aria-label={label} className={popupClass} onKeyDown={popupKeys}>
              <Menu.RadioGroup
                value={value ?? ""}
                onValueChange={(next: string) =>
                  onChange(choices.find((choice) => choice.value === next)?.value)
                }
              >
                {(clearable ? [{ value: "", label: t("Any") }, ...choices] : choices).map(
                  (choice) => (
                    <Menu.RadioItem
                      key={choice.value}
                      value={choice.value}
                      closeOnClick
                      className={itemClass}
                    >
                      <span className="grid size-4 flex-none">
                        <Menu.RadioItemIndicator>
                          <Check className="size-4" />
                        </Menu.RadioItemIndicator>
                      </span>
                      {choice.label}
                    </Menu.RadioItem>
                  ),
                )}
              </Menu.RadioGroup>
              {description && <Description>{description}</Description>}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}

/**
 * A menu of several picks, any of which matches. It stays open while picking; Any clears them.
 * A pick that is no longer offered, such as a removed source, stays listed, marked and inactive.
 */
function ManyChoiceMenu({
  label,
  description,
  choices,
  value,
  onChange,
  disabled = false,
  ...opening
}: {
  label: string;
  description: string;
  choices: readonly { readonly value: string; readonly label: string; readonly gone?: boolean }[];
  value: readonly string[] | undefined;
  onChange: (value: string[] | undefined) => void;
  disabled?: boolean;
} & Opening) {
  const picked = new Set(value ?? []);
  const said = choices.filter((choice) => picked.has(choice.value)).map((choice) => choice.label);
  const text = said.length > 0 ? said.join(", ") : undefined;

  const toggle = (choice: string, on: boolean) => {
    const next = new Set(picked);

    if (on) next.add(choice);
    else next.delete(choice);

    onChange(next.size > 0 ? [...next].sort() : undefined);
  };

  return (
    <div role="group" aria-label={label} onKeyDown={stopGridKeys}>
      <Menu.Root {...opening}>
        <Menu.Trigger
          disabled={disabled}
          aria-label={[label, text].filter(Boolean).join(": ")}
          className={triggerClass}
        >
          <TriggerText label={label} value={text} />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="start" sideOffset={8} className="z-[60]">
            <Menu.Popup aria-label={label} className={popupClass} onKeyDown={popupKeys}>
              <Menu.CheckboxItem
                checked={picked.size === 0}
                onCheckedChange={() => onChange(undefined)}
                closeOnClick
                className={itemClass}
              >
                <span className="grid size-4 flex-none">
                  <Menu.CheckboxItemIndicator>
                    <Check className="size-4" />
                  </Menu.CheckboxItemIndicator>
                </span>
                {t("Any")}
              </Menu.CheckboxItem>
              {choices.map((choice) => (
                <Menu.CheckboxItem
                  key={choice.value}
                  checked={picked.has(choice.value)}
                  // A gone choice can be unpicked, never picked again.
                  disabled={choice.gone && !picked.has(choice.value)}
                  onCheckedChange={(on) => toggle(choice.value, on)}
                  className={cn(itemClass, "data-disabled:opacity-40")}
                >
                  <span className="grid size-4 flex-none">
                    <Menu.CheckboxItemIndicator>
                      <Check className="size-4" />
                    </Menu.CheckboxItemIndicator>
                  </span>
                  <span className="min-w-0 flex-1 truncate">{choice.label}</span>
                  {choice.gone && (
                    <span className="flex-none text-xs font-normal text-white/60">
                      {t("Removed")}
                    </span>
                  )}
                </Menu.CheckboxItem>
              ))}
              <Description>{description}</Description>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}

/** From and To, each optional. Typing changes nothing until Enter or closing applies both. */
function YearMenu({
  value,
  onChange,
  defaultOpen,
  onOpenChange,
}: {
  value: TitleFilters["year"];
  onChange: (value: TitleFilters["year"]) => void;
} & Opening) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const label = t("Year");
  const text = value ? yearText(value) : undefined;

  const apply = () => {
    let [min, max] = [from, to].map((each) =>
      /^\d+$/.test(each.trim()) ? Number(each.trim()) : undefined,
    );

    if (min !== undefined && max !== undefined && min > max) [min, max] = [max, min];

    const year: NonNullable<TitleFilters["year"]> = {};

    if (min !== undefined) year.min = min;

    if (max !== undefined) year.max = max;
    onChange(min === undefined && max === undefined ? undefined : year);
  };

  const [open, setOpen] = useState(defaultOpen ?? false);

  const change = (next: boolean) => {
    if (next) {
      setFrom(value?.min?.toString() ?? "");
      setTo(value?.max?.toString() ?? "");
    } else apply();

    setOpen(next);
    onOpenChange?.(next);
  };

  const field = (name: string, text: string, set: (text: string) => void) => (
    <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-xs text-white/60">
      {name}
      <Input
        compact
        inputMode="numeric"
        value={text}
        onChange={(event) => set(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          change(false);
        }}
        className="text-[0.8125rem] text-white"
      />
    </label>
  );

  return (
    <div role="group" aria-label={label} onKeyDown={stopGridKeys}>
      <Popover.Root open={open} onOpenChange={change}>
        <Popover.Trigger
          aria-label={[label, text].filter(Boolean).join(": ")}
          className={triggerClass}
        >
          <TriggerText label={label} value={text} />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="start" sideOffset={8} className="z-[60]">
            <Popover.Popup aria-label={label} className={popupClass} onKeyDown={popupKeys}>
              <div className="flex gap-2 px-2 pt-1">
                {field(t("From"), from, setFrom)}
                {field(t("To"), to, setTo)}
              </div>
              <Description>
                {t("Leave one empty for no limit. Titles without a year never match.")}
              </Description>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

/**
 * The choices and words for every rule of this kind: provider hints and local tracks from the
 * cached catalogue, sources from the subscriptions. A picked value that is no longer offered
 * stays a choice, so it can be seen and removed.
 */
export function useRuleChoices(kind: TitleKind, filters: TitleFilters) {
  const available = useQuery(queries.titleFilterOptions(kind));
  const options = available.data;
  const subscriptions = useSubscriptions();

  const languages = new Set(options?.languages ?? []);

  if (filters.language) languages.add(filters.language);

  const verified = [...(options?.verified ?? [])];

  if (
    filters.verified &&
    !verified.some(
      (entry) =>
        entry.kind === filters.verified?.kind && entry.language === filters.verified.language,
    )
  )
    verified.push(filters.verified);

  const genres = [...new Set([...(options?.genres ?? []), ...(filters.genres ?? [])])].sort();

  const sources: { value: string; label: string; gone?: boolean }[] = subscriptions.map((each) => ({
    value: each.id,
    label: subscriptionName(each),
  }));

  // A saved source that is gone matches nothing; it stays listed as Removed, never renamed.
  for (const id of filters.sourceIds ?? [])
    if (!sources.some((each) => each.value === id))
      sources.push({ value: id, label: t("Removed"), gone: true });

  const choices = {
    genres: genres.map((value) => ({ value, label: value })),
    sources,
    qualities: QUALITY_HINTS.filter(
      (value) => options?.qualities.includes(value) || filters.quality === value,
    ).map((value) => ({ value, label: value === "unknown" ? t("Unknown") : QUALITIES[value] })),
    languages: [...TITLE_LANGUAGES.map((language) => language.code), "multi", "unknown"].flatMap(
      (value) => (languages.has(value) ? [{ value, label: hintName(value) }] : []),
    ),
    verified: verified.map((entry) => ({
      value: `${entry.kind}:${entry.language}`,
      label: verifiedName(entry.kind, entry.language),
      entry,
    })),
  };

  /** What a set rule says, as its trigger and a saved collection's summary show it. */
  const valueOf = (rule: Rule): string | undefined => {
    switch (rule) {
      case "genres":
        return filters.genres?.join(", ");
      case "year":
        return filters.year && yearText(filters.year);
      case "runtime": {
        const choice = runtimeChoice(filters.runtime);

        return choice && t(choice.label);
      }

      case "rating":
        return filters.rating?.min === undefined
          ? undefined
          : t("{rating}+", { rating: formatNumber(filters.rating.min) });
      case "watched": {
        const choice = WATCHED.find((each) => each.value === filters.watched);

        return choice && t(choice.label);
      }

      case "sourceIds":
        return filters.sourceIds
          ?.map((id) => choices.sources.find((each) => each.value === id)?.label ?? t("Removed"))
          .join(", ");
      case "quality":
        return choices.qualities.find((each) => each.value === filters.quality)?.label;
      case "language":
        return filters.language && hintName(filters.language);
      case "verified":
        return filters.verified && verifiedName(filters.verified.kind, filters.verified.language);
    }
  };

  return { available, options, choices, valueOf };
}

/** The rules a filter sets, in the bar's order. */
export function setRules(filters: TitleFilters): readonly Rule[] {
  return RULES.filter((rule) => filters[rule] !== undefined);
}

/** Two filters hold the same rules: picks are kept sorted, so key order is all that differs. */
export function sameFilters(a: TitleFilters, b: TitleFilters): boolean {
  return (
    JSON.stringify(RULES.map((rule) => a[rule])) === JSON.stringify(RULES.map((rule) => b[rule]))
  );
}

/**
 * Every rule's menu in a row. Discovery shows them all, at Any until picked; a smart collection
 * (`setOnly`) shows only the rules it sets, and + Rule adds another, which opens at once and goes
 * again if closed at Any. Picking Any removes a rule.
 */
export function RuleMenus({
  kind,
  filters,
  onFilters,
  setOnly = false,
}: TitleFilterControls & { kind: TitleKind; setOnly?: boolean }) {
  const { options, choices } = useRuleChoices(kind, filters);
  const [adding, setAdding] = useState<Rule | null>(null);

  function change<K extends Rule>(key: K, value: TitleFilters[K]) {
    const next = { ...filters };

    if (value === undefined) delete next[key];
    else next[key] = value;
    onFilters(next);
  }

  const opening = (rule: Rule): Opening =>
    rule === adding ? { defaultOpen: true, onOpenChange: (open) => open || setAdding(null) } : {};

  const needsOptions = (rule: Rule) => NEEDS_OPTIONS.some((dependent) => dependent === rule);

  const menu = (rule: Rule) => {
    const disabled = !options && needsOptions(rule);
    const label = t(RULE_NAMES[rule]);

    switch (rule) {
      case "genres":
        return (
          <ManyChoiceMenu
            label={label}
            description={t("Matches any picked genre. Titles without TMDB genres never match.")}
            choices={choices.genres}
            value={filters.genres}
            onChange={(value) => change("genres", value)}
            disabled={disabled}
            {...opening(rule)}
          />
        );
      case "year":
        return (
          <YearMenu
            value={filters.year}
            onChange={(value) => change("year", value)}
            {...opening(rule)}
          />
        );
      case "runtime":
        return (
          <TitleChoiceMenu
            label={label}
            description={t("Titles without a known runtime never match.")}
            choices={RUNTIMES.map((choice) => ({ value: choice.value, label: t(choice.label) }))}
            value={runtimeChoice(filters.runtime)?.value}
            onChange={(value) =>
              change("runtime", RUNTIMES.find((choice) => choice.value === value)?.range)
            }
            clearable
            {...opening(rule)}
          />
        );
      case "rating":
        return (
          <TitleChoiceMenu
            label={label}
            description={t("The provider's rating out of 10. Titles without one never match.")}
            choices={RATINGS.map((min) => ({
              value: String(min),
              label: t("{rating}+", { rating: formatNumber(min) }),
            }))}
            value={filters.rating?.min?.toString()}
            onChange={(value) => change("rating", value ? { min: Number(value) } : undefined)}
            clearable
            {...opening(rule)}
          />
        );
      case "watched":
        return (
          <TitleChoiceMenu
            label={label}
            description={t("From this profile's progress.")}
            choices={WATCHED.map((choice) => ({ value: choice.value, label: t(choice.label) }))}
            value={filters.watched}
            onChange={(value) => change("watched", value)}
            clearable
            {...opening(rule)}
          />
        );
      case "sourceIds":
        return (
          <ManyChoiceMenu
            label={label}
            description={t("A version from this source must meet every other rule.")}
            choices={choices.sources}
            value={filters.sourceIds}
            onChange={(value) => change("sourceIds", value)}
            {...opening(rule)}
          />
        );
      case "quality":
        return (
          <TitleChoiceMenu
            label={label}
            description={t("Hints from the provider's names, not verified picture quality.")}
            choices={choices.qualities}
            value={filters.quality}
            onChange={(value) => change("quality", value)}
            clearable
            disabled={disabled}
            {...opening(rule)}
          />
        );
      case "language":
        return (
          <TitleChoiceMenu
            label={label}
            description={t("Hints from the provider's names, not verified sound or subtitles.")}
            choices={choices.languages}
            value={filters.language}
            onChange={(value) => change("language", value)}
            clearable
            disabled={disabled}
            {...opening(rule)}
          />
        );
      case "verified":
        return (
          <TitleChoiceMenu
            label={label}
            description={t(
              "Tracks read from {count} current files on this device. Filtering opens no files.",
              { count: options?.files ?? 0 },
            )}
            choices={choices.verified}
            value={
              filters.verified ? `${filters.verified.kind}:${filters.verified.language}` : undefined
            }
            onChange={(value) =>
              change("verified", choices.verified.find((each) => each.value === value)?.entry)
            }
            clearable
            disabled={disabled}
            {...opening(rule)}
          />
        );
    }
  };

  const shown = setOnly
    ? RULES.filter((rule) => filters[rule] !== undefined || rule === adding)
    : RULES;

  const unset = RULES.filter((rule) => !shown.includes(rule) && (options || !needsOptions(rule)));

  return (
    <>
      {shown.map((rule) => (
        <Fragment key={rule}>{menu(rule)}</Fragment>
      ))}
      {setOnly && unset.length > 0 && <AddRule rules={unset} onAdd={setAdding} />}
    </>
  );
}

/** + Rule: the rules not set yet. The one picked opens its own menu next. */
function AddRule({ rules, onAdd }: { rules: readonly Rule[]; onAdd: (rule: Rule) => void }) {
  const label = t("Add rule");
  const picked = useRef(false);

  return (
    <div role="group" aria-label={label} onKeyDown={stopGridKeys}>
      <Menu.Root onOpenChange={(open) => open && (picked.current = false)}>
        <Menu.Trigger aria-label={label} className={triggerClass}>
          <Plus aria-hidden className="size-3.5 flex-none" />
          {t("Rule")}
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="start" sideOffset={8} className="z-[60]">
            <Menu.Popup
              aria-label={label}
              // A picked rule takes the focus; cancellation returns it to this trigger.
              finalFocus={() => !picked.current}
              className={popupClass}
              onKeyDown={popupKeys}
            >
              {rules.map((rule) => (
                <Menu.Item
                  key={rule}
                  closeOnClick
                  onClick={() => {
                    picked.current = true;
                    onAdd(rule);
                  }}
                  className={cn(itemClass, "px-2")}
                >
                  {rule === "verified" ? t("Verified sound or subtitles") : t(RULE_NAMES[rule])}
                </Menu.Item>
              ))}
              <Description>
                {t("A title matches when one of its versions meets every rule.")}
              </Description>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}

/** Says how many titles a runtime rule leaves out because their runtime isn't known yet. */
export function RuleNotes({ kind, filters }: { kind: TitleKind; filters: TitleFilters }) {
  const unknown = useQuery(queries.titleFilterOptions(kind)).data?.unknownRuntime ?? 0;

  if (!filters.runtime || unknown === 0) return null;

  return (
    <p className="text-[0.8125rem] text-white/60">
      {t("{count} titles have no runtime yet and are left out.", { count: unknown })}
    </p>
  );
}

export function TitleFilterBar({
  kind,
  filters,
  onFilters,
  total,
  unfiltered,
  sortControl,
  hideCount = false,
  action,
}: TitleFilterControls & {
  kind: TitleKind;
  total: number | null;
  unfiltered: number | null;
  sortControl?: ReactNode;
  hideCount?: boolean;
  /** Beside the count, such as All's Save as collection. */
  action?: ReactNode;
}) {
  const filtered = Object.keys(filters).length > 0;

  const reset = filtered && (
    <button
      onClick={() => onFilters({})}
      className="rounded-lg px-2 py-1 underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {t("Reset")}
    </button>
  );

  return (
    <div className="mb-4 flex-none pr-8 text-[0.8125rem] text-white" onKeyDown={stopGridKeys}>
      {!hideCount && (
        <div className="mb-2 flex min-h-8 items-center gap-1">
          <p className="flex-1 text-white/60 tabular-nums" aria-live="polite">
            {total !== null &&
              unfiltered !== null &&
              t("{shown} of {total}", { shown: total, total: unfiltered })}
          </p>
          {reset}
          {action}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-1 gap-y-2">
        {sortControl && (
          <>
            <div>{sortControl}</div>
            <span aria-hidden className="mx-2 h-4 border-l border-white/20" />
          </>
        )}
        <RuleMenus kind={kind} filters={filters} onFilters={onFilters} />
        {hideCount && reset && <div className="ml-2">{reset}</div>}
      </div>
      <div className="mt-2 empty:hidden">
        <RuleNotes kind={kind} filters={filters} />
        <RuleOptionsFailure kind={kind} />
      </div>
    </div>
  );
}

/** Empty matches explain the extra limit of local observations without triggering a probe. */
export function FilterEmpty({ filters }: { filters: TitleFilters }) {
  return (
    <p className="pr-8 text-[0.9375rem] text-white">
      {t("No titles match these filters.")}
      {filters.verified &&
        ` ${t("Verified tracks come from files played on this device. Filtering opens no files.")}`}
    </p>
  );
}

/** A refused options read keeps the draft and can be retried in place. */
export function RuleOptionsFailure({ kind }: { kind: TitleKind }) {
  const available = useQuery(queries.titleFilterOptions(kind));

  if (!available.error) return null;

  return (
    <p className="mt-2 text-destructive">
      {describeError(appError(available.error))}{" "}
      <button
        className="text-white underline underline-offset-4"
        onClick={() => void available.refetch()}
      >
        {t("Try again")}
      </button>
    </p>
  );
}
