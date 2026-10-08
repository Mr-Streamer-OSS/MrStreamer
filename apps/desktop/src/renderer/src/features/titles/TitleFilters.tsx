// Plain words filter this kind's grid or search. Provider name hints stay separate from tracks
// read on this device; asking for these choices never opens a file.
import { useQuery } from "@tanstack/react-query";
import type { TitleKind } from "@mrstreamer/contracts/ondemand";
import {
  QUALITY_HINTS,
  type QualityHint,
  type TitleFilters,
} from "@mrstreamer/contracts/title-filters";
import { TITLE_LANGUAGES } from "@mrstreamer/core/ondemand/languages";
import { queries } from "../../lib/queries.ts";
import { appError, describeError } from "../../lib/errors.ts";
import { cn } from "../../lib/utils.ts";

const QUALITIES: Record<QualityHint, string> = {
  "4k": "4K",
  "full-hd": "Full HD",
  hd: "HD",
  sd: "SD",
  unknown: "Unknown",
};
const englishLanguages = new Intl.DisplayNames(["en"], { type: "language" });

function hintName(code: string): string {
  if (code === "unknown") return "Unknown";
  if (code === "multi") return "MULTI";
  return TITLE_LANGUAGES.find((language) => language.code === code)?.name ?? code;
}

function verifiedName(kind: "audio" | "subtitles", language: string): string {
  const name = language === "unknown" ? "Unknown" : (englishLanguages.of(language) ?? language);
  return `${name} ${kind === "audio" ? "sound" : "subtitles"}`;
}

export interface TitleFilterControls {
  readonly filters: TitleFilters;
  readonly onFilters: (filters: TitleFilters) => void;
}

export function TitleFilterBar({
  kind,
  filters,
  onFilters,
  total,
  unfiltered,
}: TitleFilterControls & {
  kind: TitleKind;
  total: number | null;
  unfiltered: number | null;
}) {
  const available = useQuery(queries.titleFilterOptions(kind));
  const options = available.data;
  const languages = new Set(options?.languages ?? []);
  if (filters.language) languages.add(filters.language);
  const ordered = [...TITLE_LANGUAGES.map((language) => language.code), "multi", "unknown"].filter(
    (code) => languages.has(code),
  );
  const verified = [...(options?.verified ?? [])];
  if (
    filters.verified &&
    !verified.some(
      (entry) =>
        entry.kind === filters.verified?.kind && entry.language === filters.verified.language,
    )
  )
    verified.push(filters.verified);

  function change<K extends keyof TitleFilters>(key: K, value: TitleFilters[K]) {
    const next = { ...filters };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onFilters(next);
  }

  return (
    <div
      className="mb-4 flex flex-none flex-wrap items-baseline gap-x-7 gap-y-2 pr-8 text-[0.8125rem] text-white"
      onKeyDown={(event) => {
        // The poster grid listens on the window. These words own their native button keys.
        if (
          [
            "ArrowLeft",
            "ArrowRight",
            "ArrowUp",
            "ArrowDown",
            "Enter",
            " ",
            "Home",
            "End",
            "PageUp",
            "PageDown",
          ].includes(event.key)
        )
          event.stopPropagation();
      }}
    >
      <Words
        label="Quality"
        description="Hints from the provider's names, not verified picture quality."
        choices={QUALITY_HINTS.filter(
          (value) => options?.qualities.includes(value) || filters.quality === value,
        ).map((value) => ({ value, label: QUALITIES[value] }))}
        value={filters.quality}
        onChange={(value) => change("quality", value)}
      />
      <Words
        label="Language"
        description="Hints from the provider's names, not verified sound or subtitles."
        choices={ordered.map((value) => ({ value, label: hintName(value) }))}
        value={filters.language}
        onChange={(value) => change("language", value)}
        inline={6}
        trailing={["multi", "unknown"]}
      />
      {(!!options?.files || !!filters.verified) && (
        <Words
          label="Verified"
          description={`Tracks read from ${options?.files ?? 0} current files on this device. Filtering opens no files.`}
          choices={verified.map((entry) => ({
            value: `${entry.kind}:${entry.language}`,
            label: verifiedName(entry.kind, entry.language),
          }))}
          value={
            filters.verified ? `${filters.verified.kind}:${filters.verified.language}` : undefined
          }
          onChange={(value) =>
            change(
              "verified",
              verified.find((entry) => `${entry.kind}:${entry.language}` === value),
            )
          }
          inline={6}
          count={options?.files ?? 0}
        />
      )}
      <div className="ml-auto flex items-baseline gap-3 tabular-nums" aria-live="polite">
        {total !== null && unfiltered !== null && (
          <span>
            {total.toLocaleString()} of {unfiltered.toLocaleString()}
          </span>
        )}
        {Object.keys(filters).length > 0 && (
          <button onClick={() => onFilters({})} className="underline underline-offset-4">
            Reset
          </button>
        )}
      </div>
      {available.error && (
        <p className="basis-full text-destructive">
          {describeError(appError(available.error))}{" "}
          <button
            className="text-white underline underline-offset-4"
            onClick={() => void available.refetch()}
          >
            Try again
          </button>
        </p>
      )}
    </div>
  );
}

/** Extra languages remain reachable by native Tab/Enter, with Escape returning to More. */
function Words<V extends string>({
  label,
  description,
  choices,
  value,
  onChange,
  inline = Infinity,
  count,
  trailing = [],
}: {
  label: string;
  description: string;
  choices: readonly { readonly value: V; readonly label: string }[];
  value: V | undefined;
  onChange: (value: V | undefined) => void;
  inline?: number;
  count?: number;
  trailing?: readonly V[];
}) {
  const ordinary = choices.filter((choice) => !trailing.includes(choice.value));
  const first = ordinary.slice(0, inline);
  const more = ordinary.slice(inline);
  const last = choices.filter((choice) => trailing.includes(choice.value));
  const extra = more.find((choice) => choice.value === value);
  const button = (choice: { readonly value: V | undefined; readonly label: string }) => (
    <button
      key={choice.value ?? "any"}
      aria-pressed={choice.value === value}
      onClick={(event) => {
        onChange(choice.value);
        const popup = event.currentTarget.closest("details");
        if (popup) {
          popup.open = false;
          popup.querySelector("summary")?.focus();
        }
      }}
      className={cn(
        "whitespace-nowrap underline-offset-4 focus-visible:outline-white",
        choice.value === value ? "font-semibold underline" : "text-white/70 hover:text-white",
      )}
    >
      {choice.label}
    </button>
  );
  return (
    <div
      role="group"
      aria-label={label}
      title={description}
      className="flex flex-wrap items-baseline gap-x-4 gap-y-1"
    >
      <span>
        {label}
        {count !== undefined
          ? ` · ${count.toLocaleString()} ${count === 1 ? "file" : "files"}`
          : ""}
      </span>
      {button({ value: undefined, label: "Any" })}
      {first.map(button)}
      {more.length > 0 && (
        <details
          className="relative"
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !event.currentTarget.open) return;
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.open = false;
            event.currentTarget.querySelector("summary")?.focus();
          }}
        >
          <summary
            className={cn(
              "cursor-pointer list-none underline-offset-4",
              extra ? "font-semibold underline" : "text-white/70",
            )}
          >
            {extra ? `More: ${extra.label}` : "More…"}
          </summary>
          <div className="absolute top-full left-0 z-20 mt-2 flex min-w-max flex-col items-start gap-3 border border-white/20 bg-black p-3">
            {more.map(button)}
          </div>
        </details>
      )}
      {last.map(button)}
    </div>
  );
}

/** Empty matches explain the extra limit of local observations without triggering a probe. */
export function FilterEmpty({ filters }: { filters: TitleFilters }) {
  return (
    <p className="pr-8 text-[0.9375rem] text-white">
      No titles match these filters.
      {filters.verified &&
        " Verified tracks come from files played on this device. Filtering opens no files."}
    </p>
  );
}
