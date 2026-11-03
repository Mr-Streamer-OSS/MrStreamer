import {
  COLLECTION_SORTS,
  isCollectionId,
  type CollectionId,
} from "@mrstreamer/contracts/ondemand";
import { TitleFilters } from "@mrstreamer/contracts/title-filters";
import { type } from "arktype";
import type { BrowseChoices } from "./browse.ts";

export function routeChoices(params: { sort?: string; filters?: string }): BrowseChoices {
  let filters: unknown = {};

  try {
    filters = JSON.parse(params.filters ?? "{}");
  } catch {
    /* An old or invalid link uses no filters. */
  }

  const parsed = TitleFilters()(filters);
  const sort = COLLECTION_SORTS.find((value) => value === params.sort);

  const choices: BrowseChoices = { filters: parsed instanceof type.errors ? {} : parsed };

  return sort ? { ...choices, sort } : choices;
}

export function collectionId(value: string | undefined): CollectionId {
  return value && isCollectionId(value) ? value : "all";
}
