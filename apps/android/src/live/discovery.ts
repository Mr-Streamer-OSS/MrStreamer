import {
  leadingFlag,
  regionForCode,
  regionForName,
  isBroadRegion,
} from "@mrstreamer/core/catalogue/regions";
import { normalize } from "@mrstreamer/core/text";
import type { ChannelRow, Sources } from "../connect/sources.ts";

export interface Group {
  readonly name: string;
  readonly rows: readonly ChannelRow[];
}

/** Only loaded rows contribute counts. Loading and failed providers remain separate, even with results. */
const cache = new WeakMap<Sources, ReturnType<typeof collect>>();

export function discover(sources: Sources) {
  const cached = cache.get(sources);

  if (cached) return cached;
  const view = collect(sources);
  cache.set(sources, view);

  return view;
}

function collect(sources: Sources) {
  const rows: ChannelRow[] = [];
  const loading: string[] = [];
  const failed: string[] = [];
  const countries = new Map<string, ChannelRow[]>();
  const categories = new Map<string, ChannelRow[]>();

  if (sources.kind === "ready")
    for (const source of sources.sources) {
      if (source.channels.kind === "loading") loading.push(source.label);
      else if (source.channels.kind === "failed") failed.push(source.label);
      else
        for (const row of source.channels.rows) {
          rows.push(row);

          if (row.category) {
            const category = row.category;
            const categoryRows = categories.get(category);

            if (categoryRows) categoryRows.push(row);
            else categories.set(category, [row]);
            const prefix = category.split(/[|:]/)[0]!.trim();

            const country =
              leadingFlag(category)?.region ??
              regionForName(prefix) ??
              regionForCode(prefix) ??
              regionForCode(category.match(/^[[(]?([A-Z]{2,3})\s*[-|:]/)?.[1] ?? "");

            if (country && !isBroadRegion(country)) {
              const countryRows = countries.get(country);

              if (countryRows) countryRows.push(row);
              else countries.set(country, [row]);
            }
          }
        }
    }

  const groups = (map: Map<string, ChannelRow[]>): Group[] =>
    [...map].map(([name, rows]) => ({ name, rows })).sort((a, b) => a.name.localeCompare(b.name));

  return {
    rows,
    loading,
    failed,
    restoring: sources.kind === "restoring",
    countries: groups(countries),
    categories: groups(categories),
  };
}

export function findGroups(groups: readonly Group[], query: string) {
  const folded = normalize(query);

  return groups.filter((group) => normalize(group.name).includes(folded));
}
