// @vitest-environment happy-dom
import { ipc, SAVED } from "./support.ts";
import { browseResult } from "./browse-support.ts";
import { queryView } from "./mount.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { expect, it } from "vitest";
import type { Viewing } from "@mrstreamer/contracts/viewing";
import { useListOrder } from "../../src/renderer/src/features/live/reorder.ts";
import { useListChannels } from "../../src/renderer/src/features/live/lists.ts";
import { queries, useFavouriteKeys, useLastChannel } from "../../src/renderer/src/lib/queries.ts";

it("keeps channel subscribers still for title progress but publishes changed channel history", async () => {
  ipc.reset();
  ipc.always("subscription.list", [SAVED]);
  ipc.always("library.browse", browseResult([]));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = queryView(client);
  const own = (id: string) => ({ subscriptionId: SAVED.id, id });
  let snapshot: Viewing = {
    sequence: 1,
    favourites: [own("1"), own("3")],
    recent: [own("2")],
    continueWatching: [],
    marked: [],
  };
  ipc.always("viewing.get", snapshot);
  client.setQueryData(queries.viewing().queryKey, snapshot);
  let renders = 0;
  function Channels() {
    useListChannels({ kind: "favourites" });
    useListChannels({ kind: "recent" });
    useLastChannel();
    useListOrder({ kind: "favourites" }, false, []);
    const favourites = useFavouriteKeys();
    renders++;
    return createElement("output", null, [...favourites].join(","));
  }
  const publish = async (patch: Partial<Viewing>) => {
    snapshot = { ...snapshot, ...patch, sequence: snapshot.sequence + 1 };
    await act(async () => {
      client.setQueryData(queries.viewing().queryKey, snapshot);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  };
  const browsed = (id: string) =>
    ipc
      .argsOf("library.browse")
      .some((request) => request.scope.kind === "channels" && request.scope.channels[0]?.id === id);
  try {
    await view.render(createElement(Channels));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    const settled = renders;
    await publish({
      continueWatching: [
        {
          title: { kind: "movie", ...own("film") },
          position: 20,
          duration: 600,
          at: 1,
          since: 1,
          finished: false,
        },
      ],
    });
    expect(renders).toBe(settled);
    await publish({ favourites: [own("3"), own("1")] });
    expect(view.container.textContent).toBe(`${SAVED.id}:3,${SAVED.id}:1`);
    expect(browsed("3")).toBe(true);
    await publish({ recent: [own("4")] });
    expect(browsed("4")).toBe(true);
  } finally {
    view.unmount();
    ipc.reset();
  }
});
