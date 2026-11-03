import { type } from "arktype";
import { CUSTOM_LIST_NAME_MAX } from "@mrstreamer/contracts/custom-lists";
import { normalize } from "@mrstreamer/core/text";
import type { Sources } from "../connect/sources.ts";
import { store } from "../platform/store.ts";
import { resolve, same, snapshot, type ChannelList, type Draft, type Entry } from "./model.ts";

const File = type({
  version: "1",
  lists: type({
    id: "string",
    name: "string",
    entries: type({ sourceId: "string", channelId: "string", title: "string" }).array(),
  }).array(),
});

type State =
  | { readonly kind: "ready"; readonly lists: readonly ChannelList[] }
  | { readonly kind: "failed"; readonly lists: readonly ChannelList[] };

export const FAVOURITES = "favourites";
const empty: ChannelList = { id: FAVOURITES, name: "Favourites", entries: [] };

/** Whole-file writes publish only after storage succeeds; a refused edit leaves its draft untouched. */
export function listsOwner(
  platform: { readJson(name: string): unknown; writeJson(name: string, value: unknown): void },
  sources: () => Sources,
) {
  const state = store<State>({ kind: "failed", lists: [] });

  function read() {
    try {
      const raw = platform.readJson("live-lists.json");
      const parsed = raw === null ? { version: 1, lists: [empty] } : File(raw);

      if (
        parsed instanceof type.errors ||
        !parsed.lists.some((list) => list.id === FAVOURITES) ||
        new Set(parsed.lists.map((list) => list.id)).size !== parsed.lists.length
      )
        throw new Error("read");
      state.set({ kind: "ready", lists: parsed.lists });
    } catch {
      state.set({ kind: "failed", lists: state.get().lists });
    }
  }

  function lists() {
    const now = state.get();

    if (now.kind !== "ready") throw new Error("read");

    return now.lists;
  }

  function save(next: readonly ChannelList[]) {
    platform.writeJson("live-lists.json", { version: 1, lists: next });
    state.set({ kind: "ready", lists: next });
  }

  function named(name: string, except?: string) {
    const trimmed = name.trim();

    if (!trimmed || trimmed.length > CUSTOM_LIST_NAME_MAX) throw new Error("name-length");

    if (lists().some((list) => list.id !== except && normalize(list.name) === normalize(trimmed)))
      throw new Error("name-taken");

    return trimmed;
  }

  function change(id: string, update: (list: ChannelList) => ChannelList) {
    const all = lists();
    const list = all.find((each) => each.id === id);

    if (!list) throw new Error("deleted");
    save(all.map((each) => (each === list ? update(list) : each)));
  }

  function current(entry: Entry): Entry {
    const now = resolve(entry, sources());

    if (now.kind !== "listed") throw new Error(`identity-${now.kind}`);

    return { ...entry, title: now.row.title };
  }

  return {
    state,
    read,
    create(name: string, first?: Entry) {
      const valid = named(name);
      const entries = first ? [current(first)] : [];
      const id = `list-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      save([...lists(), { id, name: valid, entries }]);

      return id;
    },
    rename(id: string, name: string) {
      if (id === FAVOURITES) throw new Error("identity");
      change(id, (list) => ({ ...list, name: named(name, id) }));
    },
    delete(id: string) {
      if (id === FAVOURITES) throw new Error("identity");
      save(lists().filter((list) => list.id !== id));
    },
    member(id: string, entry: Entry, included: boolean) {
      const now = current(entry);
      change(id, (list) => ({
        ...list,
        entries: included
          ? list.entries.some((each) => same(each, now))
            ? list.entries
            : [...list.entries, now]
          : list.entries.filter((each) => !same(each, now)),
      }));
    },
    commit(draft: Draft) {
      change(draft.id, (list) => {
        if (
          snapshot(list, sources()) !== draft.snapshot ||
          draft.entries.some((entry) => !list.entries.some((each) => same(each, entry))) ||
          new Set(draft.entries.map((entry) => JSON.stringify([entry.sourceId, entry.channelId])))
            .size !== draft.entries.length
        )
          throw new Error("stale");

        return { ...list, entries: draft.entries };
      });
    },
  };
}

export type ListsOwner = ReturnType<typeof listsOwner>;
